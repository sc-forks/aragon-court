pragma solidity ^0.4.24;

import "./standards/sumtree/ISumTree.sol";
import "./standards/voting/ICRVoting.sol";

import "@aragon/os/contracts/lib/math/SafeMath.sol";


contract CourtFinalRound {
    using SafeMath for uint256;

    uint256 internal constant FINAL_ROUND_WEIGHT_PRECISION = 1000; // to improve roundings
    uint256 internal constant PCT_BASE = 10000; // ‱

    string internal constant ERROR_NOT_OWNER = "CFR_NOT_OWNER";
    string internal constant ERROR_OWNER_ALREADY_SET = "CRV_OWNER_ALREADY_SET";
    string internal constant ERROR_OVERFLOW = "CFR_OVERFLOW";

    struct JurorState {
        uint64 weight;
        bool rewarded;
    }

    struct FinalRound {
        mapping (address => JurorState) jurorSlotStates;
        uint256 disputeId;
        uint64 draftTermId;
        uint64 jurorNumber;
        uint64 coherentJurors;
        address triggeredBy;
        bool settledPenalties;
        // contains all potential penalties from jurors that voted, as they are collected when jurors commit vote
        uint256 collectedTokens;
    }

    ICRVoting internal voting;
    ISumTree internal sumTree;
    address owner;
    uint16 finalRoundReduction; // ‱ of reduction applied for final appeal round (1/10,000)
    uint256 roundId; // Court's roundId for final rounds is always the last one
    mapping (uint256 => FinalRound) finalRounds; // from disputeIds

    modifier onlyOwner {
        require(msg.sender == address(owner), ERROR_NOT_OWNER);
        _;
    }

    function init(
        address _owner,
        ICRVoting _voting,
        ISumTree _sumTree,
        uint16 _finalRoundReduction,
        uint256 _maxRegularAppealRounds
    )
        external
    {
        require(address(owner) == address(0), ERROR_OWNER_ALREADY_SET);
        owner = _owner;
        voting = _voting;
        sumTree = _sumTree;
        _setFinalRoundReduction(_finalRoundReduction);
        _setRoundId(_maxRegularAppealRounds);
    }

    function createRound(
        uint256 _disputeId,
        uint64 _draftTermId,
        address _triggeredby,
        uint64 _termId,
        uint256 _jurorMinStake,
        uint256 _heartbeatFee,
        uint256 _jurorFee
    )
        external
        onlyOwner
        returns (uint64 appealJurorNumber, uint256 feeAmount)
    {
        FinalRound storage round = finalRounds[_disputeId];

        uint256 voteId = _getVoteId(_disputeId, roundId);
        voting.createVote(voteId, 2); // TODO !!!!!!

        (appealJurorNumber, feeAmount) = _getAppealDetails(_termId, _jurorMinStake, _heartbeatFee, _jurorFee);
        round.draftTermId = _draftTermId;
        round.jurorNumber = appealJurorNumber;
        round.triggeredBy = _triggeredby;
    }

    function getAppealDetails(
        uint64 _termId,
        uint256 _jurorMinStake,
        uint256 _heartbeatFee,
        uint256 _jurorFee
    )
        external
        view
        returns (uint64 appealJurorNumber, uint256 feeAmount)
    {
        return _getAppealDetails(_termId, _jurorMinStake, _heartbeatFee, _jurorFee);
    }

    function canCommitFinalRound(uint256 _disputeId, address _voter, uint256 _sumTreeId, uint64 _deactivationTermId, uint256 _atStakeTokens, uint64 _termId, uint256 _jurorMinStake, uint16 _penaltyPct) external returns (uint256 weight) {
        /* TODO

        // weight is the number of times the minimum stake the juror has, multiplied by a precision factor for division roundings
        weight = FINAL_ROUND_WEIGHT_PRECISION *
            sumTree.getItemPast(_sumTreeId, finalRounds[_disputeId].draftTermId) /
            _jurorMinStake;

        // as it's the final round, lock tokens
        if (weight > 0) {
            FinalRound storage round = finalRounds[_disputeId];

            // weight is the number of times the minimum stake the juror has, multiplied by a precision factor for division roundings, so we remove that factor here
            uint256 weightedPenalty = _pct4(_jurorMinStake, _penaltyPct) * weight / FINAL_ROUND_WEIGHT_PRECISION;

            // Try to lock tokens
            // If there's not enough we just return 0 (so prevent juror from voting).
            // TODO: Should we use the remaining amount instead?
            uint64 slashingUpdateTermId = _termId + 1;
            // Slash from balance if the account already deactivated
            if (_deactivationTermId <= slashingUpdateTermId) {
                if (weightedPenalty > unlockedBalanceOf(_voter)) {
                    return 0;
                }
                _removeTokens(jurorToken, _voter, weightedPenalty);
            } else {
                // account.sumTreeId always > 0: as the juror has activated (and got its sumTreeId)
                uint256 treeUnlockedBalance = sumTree.getItem(_sumTreeId).sub(_atStakeTokens);
                if (weightedPenalty > treeUnlockedBalance) {
                    return 0;
                }
                sumTree.update(_sumTreeId, slashingUpdateTermId, weightedPenalty, false);
            }

            // update round state
            round.collectedTokens += weightedPenalty;
            // This shouldn't overflow. See `_getJurorWeight` and `_newFinalAdjudicationRound`. This will always be less than `jurorNumber`, which currenty is uint64 too
            round.jurorSlotStates[_voter].weight = uint64(weight);
        }
        */
    }

    function _setFinalRoundReduction(uint16 _finalRoundReduction) internal {
        require(_finalRoundReduction <= PCT_BASE, ERROR_OVERFLOW);
        finalRoundReduction = _finalRoundReduction;
    }

    function _setRoundId(uint256 _maxRegularAppealRounds) internal {
        roundId = _maxRegularAppealRounds;
    }

    // TODO: gives different results depending on when it's called!! (as it depends on current `termId`)
    function _getAppealDetails(
        uint64 _termId,
        uint256 _jurorMinStake,
        uint256 _heartbeatFee,
        uint256 _jurorFee
    )
        internal
        view
        returns (uint64 appealJurorNumber, uint256 feeAmount)
    {
        // appealJurorNumber
        // the max amount of tokens the tree can hold for this to fit in an uint64 is:
        // 2^64 * jurorMinStake / FINAL_ROUND_WEIGHT_PRECISION
        // (decimals get cancelled in the division). So it seems enough.
        appealJurorNumber = uint64(FINAL_ROUND_WEIGHT_PRECISION * sumTree.totalSumPresent(_termId) / _jurorMinStake);

        // feeAmouunt
        // number of jurors is the number of times the minimum stake is hold in the tree, multiplied by a precision factor for division roundings
        // besides, apply final round discount
        feeAmount = _heartbeatFee +
            _pct4(appealJurorNumber * _jurorFee / FINAL_ROUND_WEIGHT_PRECISION, finalRoundReduction);
    }

    function _getVoteId(uint256 _disputeId, uint256 _roundId) internal pure returns (uint256) {
        return (_disputeId << 128) + _roundId;
    }

    function _decodeVoteId(uint256 _voteId) internal pure returns (uint256 disputeId, uint256 roundId) {
        disputeId = _voteId >> 128;
        roundId = _voteId & 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
    }

    function _pct4(uint256 _number, uint16 _pct) internal pure returns (uint256) {
        return _number * uint256(_pct) / PCT_BASE;
    }
}
