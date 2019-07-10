pragma solidity ^0.4.24;

import "../sumtree/ISumTree.sol";
import "../voting/ICRVoting.sol";


interface IFinalRound {
    function init(address _owner, ICRVoting _voting, ISumTree _sumTree, uint16 _finalRoundReduction, uint256 _maxRegularAppealRounds) external;
    function createRound(uint256 _disputeId, uint64 _draftTermId, address _triggeredby, uint64 _termId, uint256 _jurorMinStake, uint256 _heartbeatFee, uint256 _jurorFee) external returns (uint64 appealJurorNumber, uint256 feeAmount);
    function getAppealDetails(uint64 _termId, uint256 _jurorMinStake, uint256 _heartbeatFee, uint256 _jurorFee) external view returns (uint64 appealJurorNumber, uint256 feeAmount);
    function canCommitFinalRound(uint256 _disputeId, address _voter, uint256 _sumTreeId, uint64 _deactivationTermId, uint256 _atStakeTokens, uint64 _termId, uint256 _jurorMinStake, uint16 _penaltyPct) external returns (uint256 weight);
}
