const { bigExp } = require('../helpers/numbers')(web3)
const { assertRevert } = require('@aragon/os/test/helpers/assertThrow')
const { advanceBlocks } = require('../helpers/blocks')(web3)
const { TOMORROW, ONE_DAY } = require('../helpers/time')
const { decodeEventsOfType } = require('../helpers/decodeEvent')
const { getEventAt, getEvents } = require('@aragon/os/test/helpers/events')
const { buildHelper, DISPUTE_STATES } = require('../helpers/court')(web3, artifacts)
const { assertAmountOfEvents, assertEvent } = require('@aragon/os/test/helpers/assertEvent')(web3)

const MiniMeToken = artifacts.require('MiniMeToken')
const Arbitrable = artifacts.require('ArbitrableMock')
const JurorsRegistry = artifacts.require('JurorsRegistry')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ACTIVATE_DATA = web3.sha3('activate(uint256)').slice(0, 10)

contract('Court', ([_, disputer, drafter, juror500, juror1000, juror1500, juror2000]) => {
  let courtHelper, court, feeToken, arbitrable

  const termDuration = ONE_DAY
  const firstTermStartTime = TOMORROW
  const jurorFee = bigExp(10, 18)
  const heartbeatFee = bigExp(20, 18)
  const draftFee = bigExp(30, 18)
  const settleFee = bigExp(40, 18)

  const jurors = [
    { address: juror500,  initialActiveBalance: bigExp(500,  18) },
    { address: juror1000, initialActiveBalance: bigExp(1000, 18) },
    { address: juror1500, initialActiveBalance: bigExp(1500, 18) },
    { address: juror2000, initialActiveBalance: bigExp(2000, 18) },
  ]

  beforeEach('create court', async () => {
    courtHelper = buildHelper()
    feeToken = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'Court Fee Token', 18, 'CFT', true)
    court = await courtHelper.deploy({ firstTermStartTime, termDuration, feeToken, jurorFee, heartbeatFee, draftFee, settleFee })
  })

  describe('draft', () => {
    beforeEach('mock subscriptions and arbitrable instance', async () => {
      arbitrable = await Arbitrable.new()
      await courtHelper.subscriptions.setUpToDate(true)
    })

    context('when the given dispute exists', () => {
      const roundId = 0
      const disputeId = 0
      const draftTermId = 4
      const jurorsNumber = 10
      const possibleRulings = 2

      beforeEach('activate jurors', async () => {
        for(let i = 0; i < jurors.length; i++) {
          await courtHelper.jurorToken.generateTokens(jurors[i].address, jurors[i].initialActiveBalance)
          await courtHelper.jurorToken.approveAndCall(courtHelper.jurorsRegistry.address, jurors[i].initialActiveBalance, ACTIVATE_DATA, { from: jurors[i].address })
        }
      })

      beforeEach('create dispute', async () => {
        const jurorFees = jurorFee.mul(jurorsNumber)
        const jurorRewards = (draftFee.plus(settleFee)).mul(jurorsNumber)
        const disputeCollateral = jurorFees.plus(heartbeatFee).plus(jurorRewards)
        await feeToken.generateTokens(disputer, disputeCollateral)
        await feeToken.approve(court.address, disputeCollateral, { from: disputer })

        await courtHelper.setTimestamp(firstTermStartTime)
        await court.heartbeat(1)
        await court.createDispute(arbitrable.address, possibleRulings, jurorsNumber, draftTermId, { from: disputer })
      })

      const itDraftsRequestedRoundInOneBatch = (term, jurorsToBeDrafted) => {
        const expectedDraftedJurors = jurorsToBeDrafted > jurorsNumber ? jurorsNumber : jurorsToBeDrafted

        it('selects random jurors for the last round of the dispute', async () => {
          const receipt = await court.draft(disputeId, jurorsToBeDrafted, { from: drafter })

          const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, 'JurorDrafted')
          assertAmountOfEvents({ logs }, 'JurorDrafted', expectedDraftedJurors)

          const jurorsAddresses = jurors.map(j => web3.toChecksumAddress(j.address))
          for(let i = 0; i < expectedDraftedJurors; i++) {
            const { disputeId: eventDisputeId, juror } = getEventAt({ logs }, 'JurorDrafted', i).args
            assert.equal(eventDisputeId.toString(), disputeId, 'dispute id does not match')
            assert.isTrue(jurorsAddresses.includes(juror), 'drafted juror is not included in the list')
          }
        })

        if (expectedDraftedJurors === jurorsNumber) {
          it('ends the dispute draft', async () => {
            const receipt = await court.draft(disputeId, jurorsToBeDrafted, { from: drafter })

            assertAmountOfEvents(receipt, 'DisputeStateChanged')
            assertEvent(receipt, 'DisputeStateChanged', { disputeId, state: DISPUTE_STATES.ADJUDICATING })

            const [subject, rulings, state, finalRuling] = await court.getDispute(disputeId)
            assert.equal(state, DISPUTE_STATES.ADJUDICATING, 'dispute state does not match')

            assert.equal(subject, arbitrable.address, 'dispute subject does not match')
            assert.equal(rulings.toString(), possibleRulings, 'dispute possible rulings do not match')
            assert.equal(finalRuling.toString(), 0, 'dispute final ruling does not match')
          })
        } else {
          it('does not end the dispute draft', async () => {
            const receipt = await court.draft(disputeId, jurorsToBeDrafted, { from: drafter })

            assertAmountOfEvents(receipt, 'DisputeStateChanged', 0)

            const [subject, rulings, state, finalRuling] = await court.getDispute(disputeId)
            assert.equal(state, DISPUTE_STATES.PRE_DRAFT, 'dispute state does not match')

            assert.equal(subject, arbitrable.address, 'dispute subject does not match')
            assert.equal(rulings.toString(), possibleRulings, 'dispute possible rulings do not match')
            assert.equal(finalRuling.toString(), 0, 'dispute final ruling does not match')
          })
        }

        it('updates last round information', async () => {
          await court.draft(disputeId, jurorsToBeDrafted, { from: drafter })

          const [draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, triggeredBy] = await court.getAdjudicationRound(disputeId, roundId)

          assert.equal(draftTerm.toString(), draftTermId, 'round draft term does not match')
          assert.equal(delayedTerms.toString(), expectedDraftedJurors === jurorsNumber ? (term - draftTermId) : 0, 'delayed terms do not match')
          assert.equal(roundJurorsNumber.toString(), jurorsNumber, 'round jurors number does not match')
          assert.equal(selectedJurors.toString(), expectedDraftedJurors, 'selected jurors does not match')
          assert.equal(triggeredBy, disputer, 'dispute round caller does not match')
        })

        it('sets the correct state for each juror', async () => {
          const receipt = await court.draft(disputeId, jurorsToBeDrafted, { from: drafter })

          const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, 'JurorDrafted')
          const events = getEvents({ logs }, 'JurorDrafted')

          for(let i = 0; i < jurors.length; i++) {
            const jurorAddress = web3.toChecksumAddress(jurors[i].address)
            const expectedWeight = events.filter(({ args: { juror } }) => juror === jurorAddress).length
            const [weight, rewarded] = await court.getJuror(disputeId, roundId, jurorAddress)

            assert.equal(weight.toString(), expectedWeight, 'juror weight does not match')
            assert.isFalse(rewarded, 'juror should not have been rewarded yet')
          }
        })

        it('deposits the draft fee to the accounting for the caller', async () => {
          const expectedFee = draftFee.mul(expectedDraftedJurors)
          const previousCourtAmount = await feeToken.balanceOf(court.address)
          const previousAccountingAmount = await feeToken.balanceOf(courtHelper.accounting.address)
          const previousDrafterAmount = await courtHelper.accounting.balanceOf(feeToken.address, drafter)

          await court.draft(disputeId, jurorsToBeDrafted, { from: drafter })

          const currentCourtAmount = await feeToken.balanceOf(court.address)
          assert.equal(previousCourtAmount.toString(), currentCourtAmount.toString(), 'court balances should remain the same')

          const currentAccountingAmount = await feeToken.balanceOf(courtHelper.accounting.address)
          assert.equal(previousAccountingAmount.toString(), currentAccountingAmount.toString(), 'accounting balances should remain the same')

          const currentDrafterAmount = await courtHelper.accounting.balanceOf(feeToken.address, drafter)
          assert.equal(previousDrafterAmount.plus(expectedFee).toString(), currentDrafterAmount.toString(), 'drafter amount does not match')
        })
      }

      const itDraftsRequestedRoundInMultipleBatches = (term, jurorsToBeDrafted, batches) => {
        const jurorsPerBatch = jurorsToBeDrafted  / batches

        it('selects random jurors for the last round of the dispute', async () => {
          const jurorsAddresses = jurors.map(j => web3.toChecksumAddress(j.address))

          for (let batch = 0; batch < batches; batch++) {
            const receipt = await court.draft(disputeId, jurorsPerBatch, { from: drafter })

            const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, 'JurorDrafted')
            assertAmountOfEvents({ logs }, 'JurorDrafted', jurorsPerBatch)

            for(let i = 0; i < jurorsPerBatch; i++) {
              const { disputeId: eventDisputeId, juror } = getEventAt({ logs }, 'JurorDrafted', i).args
              assert.equal(eventDisputeId.toString(), disputeId, 'dispute id does not match')
              assert.isTrue(jurorsAddresses.includes(juror), 'drafted juror is not included in the list')
            }

            // advance one term to avoid drafting all the batches in the same term
            await courtHelper.increaseTime(termDuration)
            await court.heartbeat(1)
            await advanceBlocks(1)
          }
        })

        it('ends the dispute draft', async () => {
          let lastReceipt
          for (let batch = 0; batch < batches; batch++) {
            lastReceipt = await court.draft(disputeId, jurorsPerBatch, { from: drafter })

            // advance one term to avoid drafting all the batches in the same term
            await courtHelper.increaseTime(termDuration)
            await court.heartbeat(1)
            await advanceBlocks(1)
          }

          assertAmountOfEvents(lastReceipt, 'DisputeStateChanged')
          assertEvent(lastReceipt, 'DisputeStateChanged', { disputeId, state: DISPUTE_STATES.ADJUDICATING })

          const [subject, rulings, state, finalRuling] = await court.getDispute(disputeId)
          assert.equal(state, DISPUTE_STATES.ADJUDICATING, 'dispute state does not match')

          assert.equal(subject, arbitrable.address, 'dispute subject does not match')
          assert.equal(rulings.toString(), possibleRulings, 'dispute possible rulings do not match')
          assert.equal(finalRuling.toString(), 0, 'dispute final ruling does not match')
        })

        it('updates the last round information', async () => {
          let lastTerm
          for (let batch = 0; batch < batches; batch++) {
            await court.draft(disputeId, jurorsPerBatch, { from: drafter })
            lastTerm = await court.getLastEnsuredTermId()

            // advance one term to avoid drafting all the batches in the same term
            await courtHelper.increaseTime(termDuration)
            await court.heartbeat(1)
            await advanceBlocks(1)
          }

          const [draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, triggeredBy] = await court.getAdjudicationRound(disputeId, roundId)

          assert.equal(draftTerm.toString(), draftTermId, 'round draft term does not match')
          assert.equal(delayedTerms.toString(), lastTerm.minus(draftTermId).toString(), 'delayed terms do not match')
          assert.equal(roundJurorsNumber.toString(), jurorsNumber, 'round jurors number does not match')
          assert.equal(selectedJurors.toString(), jurorsNumber, 'selected jurors does not match')
          assert.equal(triggeredBy, disputer, 'dispute round caller does not match')
        })

        it('sets the correct state for each juror', async () => {
          const expectedWeights = {}

          for (let batch = 0; batch < batches; batch++) {
            const receipt = await court.draft(disputeId, jurorsPerBatch, { from: drafter })

            const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, 'JurorDrafted')
            const events = getEvents({ logs }, 'JurorDrafted')

            for(let i = 0; i < jurors.length; i++) {
              const jurorAddress = web3.toChecksumAddress(jurors[i].address)
              const batchWeight = events.filter(({ args: { juror } }) => juror === jurorAddress).length
              expectedWeights[jurorAddress] = (expectedWeights[jurorAddress] || 0) + batchWeight
            }

            // advance one term to avoid drafting all the batches in the same term
            await courtHelper.increaseTime(termDuration)
            await court.heartbeat(1)
            await advanceBlocks(1)
          }

          for(let i = 0; i < jurors.length; i++) {
            const jurorAddress = web3.toChecksumAddress(jurors[i].address)
            const [weight, rewarded] = await court.getJuror(disputeId, roundId, jurorAddress)

            assert.equal(weight.toString(), expectedWeights[jurorAddress], `juror ${jurorAddress} weight does not match`)
            assert.isFalse(rewarded, 'juror should not have been rewarded yet')
          }
        })

        it('deposits the draft fee to the accounting for the caller', async () => {
          for (let batch = 0; batch < batches; batch++) {
            const expectedFee = draftFee.mul(jurorsPerBatch)
            const previousCourtAmount = await feeToken.balanceOf(court.address)
            const previousAccountingAmount = await feeToken.balanceOf(courtHelper.accounting.address)
            const previousDrafterAmount = await courtHelper.accounting.balanceOf(feeToken.address, drafter)

            await court.draft(disputeId, jurorsPerBatch, { from: drafter })

            const currentCourtAmount = await feeToken.balanceOf(court.address)
            assert.equal(previousCourtAmount.toString(), currentCourtAmount.toString(), 'court balances should remain the same')

            const currentAccountingAmount = await feeToken.balanceOf(courtHelper.accounting.address)
            assert.equal(previousAccountingAmount.toString(), currentAccountingAmount.toString(), 'accounting balances should remain the same')

            const currentDrafterAmount = await courtHelper.accounting.balanceOf(feeToken.address, drafter)
            assert.equal(previousDrafterAmount.plus(expectedFee).toString(), currentDrafterAmount.toString(), 'drafter amount does not match')

            // advance one term to avoid drafting all the batches in the same term
            await courtHelper.increaseTime(termDuration)
            await court.heartbeat(1)
            await advanceBlocks(1)
          }
        })
      }

      const itHandlesDraftsProperly = term => {
        // NOTE: To test this scenario we cannot mock the blocknumber, we need a real block mining to have different blockhashes

        context('when the current block is the randomness block number', () => {
          it('reverts', async () => {
            await assertRevert(court.draft(disputeId, jurorsNumber, { from: drafter }), 'CTRANDOM_NOT_YET')
          })
        })

        context('when the current block is the following block of the randomness block number', () => {
          beforeEach('move one block after the draft term', async () => {
            await advanceBlocks(1)
          })

          context('when drafting all the requested jurors', () => {
            const jurorsToBeDrafted = jurorsNumber

            context('when drafting in one batch', () => {
              itDraftsRequestedRoundInOneBatch(term, jurorsToBeDrafted)
            })

            context('when drafting in multiple batches', () => {
              const batches = 10

              itDraftsRequestedRoundInMultipleBatches(term, jurorsToBeDrafted, batches)
            })
          })

          context('when half amount of the requested jurors', () => {
            const jurorsToBeDrafted = jurorsNumber / 2

            itDraftsRequestedRoundInOneBatch(term, jurorsToBeDrafted)
          })

          context('when drafting more than the requested jurors', () => {
            const jurorsToBeDrafted = jurorsNumber * 2

            itDraftsRequestedRoundInOneBatch(term, jurorsToBeDrafted)
          })
        })

        context('when the current term is after the randomness block number by less than 256 blocks', () => {
          beforeEach('move 255 blocks after the draft term', async () => {
            await advanceBlocks(255)
          })

          context('when drafting all the requested jurors', () => {
            const jurorsToBeDrafted = jurorsNumber

            context('when drafting in one batch', () => {
              itDraftsRequestedRoundInOneBatch(term, jurorsToBeDrafted)
            })

            context('when drafting in multiple batches', () => {
              const batches = 2

              itDraftsRequestedRoundInMultipleBatches(term, jurorsToBeDrafted, batches)
            })
          })

          context('when half amount of the requested jurors', () => {
            const jurorsToBeDrafted = jurorsNumber / 2

            itDraftsRequestedRoundInOneBatch(term, jurorsToBeDrafted)
          })

          context('when drafting more than the requested jurors', () => {
            const jurorsToBeDrafted = jurorsNumber * 2

            itDraftsRequestedRoundInOneBatch(term, jurorsToBeDrafted)
          })
        })

        context('when the current term is after the randomness block number by 256 blocks', () => {
          beforeEach('move 256 blocks after the draft term', async () => {
            await advanceBlocks(256)
          })

          context('when drafting all the requested jurors', () => {
            const jurorsToBeDrafted = jurorsNumber

            context('when drafting in one batch', () => {
              itDraftsRequestedRoundInOneBatch(term, jurorsToBeDrafted)
            })

            context('when drafting in multiple batches', () => {
              const batches = 2

              itDraftsRequestedRoundInMultipleBatches(term, jurorsToBeDrafted, batches)
            })
          })

          context('when drafting half amount of the requested jurors', () => {
            const jurorsToBeDrafted = jurorsNumber / 2

            itDraftsRequestedRoundInOneBatch(term, jurorsToBeDrafted)
          })

          context('when drafting more than the requested jurors', () => {
            const jurorsToBeDrafted = jurorsNumber * 2

            itDraftsRequestedRoundInOneBatch(term, jurorsToBeDrafted)
          })
        })

        context('when the current term is after the randomness block number by more than 256 blocks', () => {
          beforeEach('move 257 blocks after the draft term', async () => {
            await advanceBlocks(257)
          })

          it('reverts', async () => {
            await assertRevert(court.draft(disputeId, jurorsNumber, { from: drafter }), 'CT_TERM_RANDOMNESS_NOT_AVAILABLE')
          })
        })
      }

      const itHandlesDraftsProperlyForTerm = term => {
        beforeEach('move to the draft term', async () => {
          // the first term was already ensured when creating the dispute
          await courtHelper.increaseTime((term - 1) * termDuration)
        })

        context('when the given dispute was not drafted', () => {
          context('when the court term is up-to-date', () => {
            beforeEach('ensure term', async () => {
              await court.heartbeat(term)
            })

            itHandlesDraftsProperly(term)
          })

          context('when the court term is outdated by one term', () => {
            beforeEach('ensure term', async () => {
              await court.heartbeat(term - 1)
            })

            itHandlesDraftsProperly(term)
          })

          context('when the court term is outdated by more than one term', () => {
            beforeEach('ensure term', async () => {
              await advanceBlocks(10)
            })

            it('reverts', async () => {
              await assertRevert(court.draft(disputeId, jurorsNumber, { from: drafter }), 'CTTOO_MANY_TRANSITIONS')
            })
          })
        })

        context('when the given dispute was already drafted', () => {
          beforeEach('draft dispute', async () => {
            await court.heartbeat(term)
            await advanceBlocks(10)
            await court.draft(disputeId, jurorsNumber, { from: drafter })
          })

          it('reverts', async () => {
            await assertRevert(court.draft(disputeId, jurorsNumber, { from: drafter }), 'CTROUND_ALRDY_DRAFTED')
          })
        })
      }

      context('when the current term is previous the draft term', () => {
        it('reverts', async () => {
          await assertRevert(court.draft(disputeId, jurorsNumber, { from: drafter }), 'CTNOT_DRAFT_TERM')
        })
      })

      context('when the current term is the draft term', () => {
        const currentTerm = draftTermId

        itHandlesDraftsProperlyForTerm(currentTerm)
      })

      context('when the current term is after the draft term', () => {
        const currentTerm = draftTermId + 10

        itHandlesDraftsProperlyForTerm(currentTerm)
      })
    })

    context('when the given dispute does not exist', () => {
      // TODO: this scenario is not implemented in the contracts yet
      it.skip('reverts', async () => {
        await assertRevert(court.draft(0, 10), 'CT_DISPUTE_DOES_NOT_EXIST')
      })
    })
  })
})