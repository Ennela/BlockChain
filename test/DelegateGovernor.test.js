/**
 * DelegateGovernor — vòng đời proposal, bỏ phiếu, quorum, kết quả, hủy, quản trị tham số.
 *
 * Fixture (tổng cung 1000 DAOT, quorum 20% = 200, votingDelay 1, votingPeriod 10):
 *
 *   người   | token | đại diện | voting power
 *   alice   |  400  | alice    | 400
 *   bob     |  300  | bob      | 300 + 100 (của carol) = 400
 *   carol   |  100  | bob      |   0  ← đã ủy quyền, không tự vote được
 *   dave    |   50  | dave     |  50
 *   owner   |  150  | owner    | 150
 *
 * Mốc block của proposal tạo ở block N:  snapshot = N+1 · Active từ N+2 · voteEnd = N+11.
 * `state()` là view nên block.number của nó có thể là block mới nhất hoặc kế tiếp; test vì vậy
 * kiểm tra biên bằng transaction (block.number chính xác) và chỉ dùng `state()` ở chỗ cách xa biên.
 */

const GovernanceToken = artifacts.require('GovernanceToken');
const DelegateGovernor = artifacts.require('DelegateGovernor');
const {
  advanceBlocks,
  advanceToBlock,
  expectRevert,
  findEvents,
  tokens,
  ZERO_ADDRESS,
} = require('./helpers/evm');

const State = { Pending: 0, Active: 1, Defeated: 2, Succeeded: 3, Executed: 4, Canceled: 5 };
const Vote = { Against: 0, For: 1, Abstain: 2 };

contract('DelegateGovernor', (accounts) => {
  const [owner, alice, bob, carol, dave, erin, frank] = accounts;
  let token;
  let governor;

  beforeEach(async () => {
    token = await GovernanceToken.new(owner, tokens(1000));
    await token.transfer(alice, tokens(400), { from: owner });
    await token.transfer(bob, tokens(300), { from: owner });
    await token.transfer(carol, tokens(100), { from: owner });
    await token.transfer(dave, tokens(50), { from: owner });

    await token.delegate(alice, { from: alice });
    await token.delegate(bob, { from: bob });
    await token.delegate(bob, { from: carol });
    await token.delegate(dave, { from: dave });
    await token.delegate(owner, { from: owner });

    governor = await DelegateGovernor.new(token.address, 1, 10, 20, owner);
  });

  /** Tạo proposal; trả về id và thông tin mốc block đọc từ chain. */
  async function propose(from = alice, description = 'Tăng ngân sách marketing') {
    const receipt = await governor.createProposal(description, { from });
    const id = findEvents(receipt, 'ProposalCreated')[0].args.proposalId;
    const p = await governor.getProposal(id);
    return {
      id,
      receipt,
      snapshot: Number(p.snapshotBlock),
      start: Number(p.voteStart),
      end: Number(p.voteEnd),
    };
  }

  /** Đưa chain tới mức transaction kế tiếp rơi đúng vào block đầu tiên của kỳ bỏ phiếu. */
  async function toVotingStart(proposal) {
    await advanceToBlock(proposal.start - 1);
  }

  /** Đưa chain qua hẳn cuối kỳ bỏ phiếu, xa biên để `state()` không mơ hồ. */
  async function pastVotingEnd(proposal) {
    await advanceToBlock(proposal.end + 2);
  }

  const stateOf = async (id) => Number(await governor.state(id));

  describe('Constructor', () => {
    it('lưu đúng tham số', async () => {
      assert.equal(await governor.token(), token.address);
      assert.equal((await governor.votingDelay()).toString(), '1');
      assert.equal((await governor.votingPeriod()).toString(), '10');
      assert.equal((await governor.quorumNumerator()).toString(), '20');
      assert.equal(await governor.owner(), owner);
    });

    it('revert với token = address(0)', async () => {
      await expectRevert(
        DelegateGovernor.new(ZERO_ADDRESS, 1, 10, 20, owner),
        'GovernorInvalidTokenAddress'
      );
    });

    it('revert với votingDelay = 0 (getPastVotes sẽ revert nếu snapshot chưa qua)', async () => {
      await expectRevert(
        DelegateGovernor.new(token.address, 0, 10, 20, owner),
        'GovernorInvalidVotingDelay'
      );
    });

    it('revert với votingPeriod = 0', async () => {
      await expectRevert(
        DelegateGovernor.new(token.address, 1, 0, 20, owner),
        'GovernorInvalidVotingPeriod'
      );
    });

    it('revert với quorum = 0 hoặc > 100', async () => {
      await expectRevert(
        DelegateGovernor.new(token.address, 1, 10, 0, owner),
        'GovernorInvalidQuorumNumerator'
      );
      await expectRevert(
        DelegateGovernor.new(token.address, 1, 10, 101, owner),
        'GovernorInvalidQuorumNumerator'
      );
    });
  });

  describe('Tạo proposal', () => {
    it('id tăng dần từ 1 và emit ProposalCreated đúng mốc block', async () => {
      const first = await propose();
      const second = await propose(bob, 'Đề xuất thứ hai');

      assert.equal(first.id.toString(), '1');
      assert.equal(second.id.toString(), '2');
      assert.equal((await governor.proposalCount()).toString(), '2');

      const event = findEvents(first.receipt, 'ProposalCreated')[0];
      const creationBlock = first.receipt.receipt.blockNumber;
      assert.equal(event.args.proposer, alice);
      assert.equal(Number(event.args.snapshotBlock), creationBlock + 1, 'snapshot = N + votingDelay');
      assert.equal(Number(event.args.voteStart), creationBlock + 2);
      assert.equal(Number(event.args.voteEnd), creationBlock + 11);
      assert.equal(event.args.snapshotTotalSupply.toString(), tokens(1000));
    });

    it('proposal mới ở trạng thái Pending', async () => {
      const { id } = await propose();
      assert.equal(await stateOf(id), State.Pending);
    });

    it('lưu proposer, mô tả và chưa có phiếu nào', async () => {
      const { id } = await propose(bob, 'Mô tả của bob');
      const p = await governor.getProposal(id);
      assert.equal(p.proposer, bob);
      assert.equal(p.description, 'Mô tả của bob');
      assert.equal(p.forVotes.toString(), '0');
      assert.isFalse(p.executed);
      assert.isFalse(p.canceled);
    });

    it('revert với mô tả rỗng', async () => {
      await expectRevert(governor.createProposal('', { from: alice }), 'GovernorEmptyDescription');
    });

    it('chấp nhận mô tả đúng 1000 byte, revert khi 1001 byte', async () => {
      await governor.createProposal('a'.repeat(1000), { from: alice });
      await expectRevert(
        governor.createProposal('a'.repeat(1001), { from: alice }),
        'GovernorDescriptionTooLong'
      );
    });

    it('người không có token không tạo được proposal', async () => {
      await expectRevert(
        governor.createProposal('Spam', { from: erin }),
        'GovernorNoVotingPowerToPropose'
      );
    });

    it('người giữ token nhưng CHƯA delegate không tạo được proposal', async () => {
      await token.transfer(frank, tokens(10), { from: owner });
      assert.equal((await token.balanceOf(frank)).toString(), tokens(10));
      await expectRevert(
        governor.createProposal('Có token nhưng chưa kích hoạt', { from: frank }),
        'GovernorNoVotingPowerToPropose'
      );

      await token.delegate(frank, { from: frank });
      await governor.createProposal('Giờ thì được', { from: frank });
    });

    it('người đã ủy quyền hết phiếu cho người khác (carol) không tạo được proposal', async () => {
      await expectRevert(
        governor.createProposal('carol không còn phiếu', { from: carol }),
        'GovernorNoVotingPowerToPropose'
      );
    });
  });

  describe('Cửa sổ bỏ phiếu', () => {
    it('chưa tới voteStart thì không vote được', async () => {
      const { id } = await propose();
      // transaction kế tiếp ở block N+1 < voteStart = N+2
      await expectRevert(governor.castVote(id, Vote.For, { from: alice }), 'GovernorProposalNotActive');
    });

    it('vote được ở block voteStart và state là Active', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.For, { from: alice });
      assert.equal(await stateOf(proposal.id), State.Active);
    });

    it('vote được ở block voteEnd (biên cuối còn hợp lệ)', async () => {
      const proposal = await propose();
      await advanceToBlock(proposal.end - 1); // tx kế tiếp rơi vào đúng voteEnd
      await governor.castVote(proposal.id, Vote.For, { from: alice });
    });

    it('vote ở block voteEnd + 1 thì revert', async () => {
      const proposal = await propose();
      await advanceToBlock(proposal.end); // tx kế tiếp rơi vào voteEnd + 1
      await expectRevert(
        governor.castVote(proposal.id, Vote.For, { from: alice }),
        'GovernorProposalNotActive'
      );
    });
  });

  describe('Bỏ phiếu', () => {
    let proposal;

    beforeEach(async () => {
      proposal = await propose();
      await toVotingStart(proposal);
    });

    it('đếm đúng For / Against / Abstain theo voting power tại snapshot', async () => {
      await governor.castVote(proposal.id, Vote.For, { from: alice }); // 400
      await governor.castVote(proposal.id, Vote.Against, { from: bob }); // 300 + 100 của carol
      await governor.castVote(proposal.id, Vote.Abstain, { from: dave }); // 50

      const votes = await governor.proposalVotes(proposal.id);
      assert.equal(votes.forVotes.toString(), tokens(400));
      assert.equal(votes.againstVotes.toString(), tokens(400));
      assert.equal(votes.abstainVotes.toString(), tokens(50));
    });

    it('ghi receipt và emit VoteCast kèm lý do', async () => {
      const receipt = await governor.castVoteWithReason(proposal.id, Vote.For, 'Vì lợi ích chung', {
        from: alice,
      });
      const event = findEvents(receipt, 'VoteCast')[0];
      assert.equal(event.args.voter, alice);
      assert.equal(event.args.proposalId.toString(), proposal.id.toString());
      assert.equal(Number(event.args.support), Vote.For);
      assert.equal(event.args.votes.toString(), tokens(400));
      assert.equal(event.args.reason, 'Vì lợi ích chung');

      const r = await governor.getReceipt(proposal.id, alice);
      assert.isTrue(r.hasVoted);
      assert.equal(Number(r.support), Vote.For);
      assert.equal(r.votes.toString(), tokens(400));
      assert.isTrue(await governor.hasVoted(proposal.id, alice));
      assert.isFalse(await governor.hasVoted(proposal.id, dave));
    });

    it('đại diện vote bằng phiếu cộng dồn của người ủy quyền (bob = 300 + 100)', async () => {
      await governor.castVote(proposal.id, Vote.For, { from: bob });
      const r = await governor.getReceipt(proposal.id, bob);
      assert.equal(r.votes.toString(), tokens(400));
    });

    it('người đã ủy quyền (carol) không tự vote được', async () => {
      await expectRevert(
        governor.castVote(proposal.id, Vote.For, { from: carol }),
        'GovernorNoVotingPower'
      );
    });

    it('người có token nhưng chưa delegate không vote được', async () => {
      await token.transfer(frank, tokens(10), { from: owner });
      await expectRevert(
        governor.castVote(proposal.id, Vote.For, { from: frank }),
        'GovernorNoVotingPower'
      );
    });

    it('revert khi support không hợp lệ', async () => {
      await expectRevert(governor.castVote(proposal.id, 3, { from: alice }), 'GovernorInvalidVoteType');
    });

    it('revert khi vote lần hai (chống double voting)', async () => {
      await governor.castVote(proposal.id, Vote.For, { from: alice });
      await expectRevert(
        governor.castVote(proposal.id, Vote.Against, { from: alice }),
        'GovernorAlreadyVoted'
      );
      const votes = await governor.proposalVotes(proposal.id);
      assert.equal(votes.forVotes.toString(), tokens(400), 'phiếu đầu giữ nguyên');
      assert.equal(votes.againstVotes.toString(), '0');
    });

    it('revert với proposal không tồn tại (id 0 và id quá lớn)', async () => {
      await expectRevert(governor.castVote(0, Vote.For, { from: alice }), 'GovernorNonexistentProposal');
      await expectRevert(governor.castVote(99, Vote.For, { from: alice }), 'GovernorNonexistentProposal');
    });
  });

  describe('Kết quả: quorum và điều kiện thắng', () => {
    it('Succeeded: For > Against và đủ quorum', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.For, { from: alice }); // 400 ≥ 200
      await pastVotingEnd(proposal);
      assert.equal(await stateOf(proposal.id), State.Succeeded);
    });

    it('Defeated: For > Against nhưng KHÔNG đủ quorum', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.For, { from: dave }); // 50 < 200, Against = 0
      await pastVotingEnd(proposal);
      assert.equal(await stateOf(proposal.id), State.Defeated);
    });

    it('Defeated: hòa phiếu (For == Against) dù vượt quorum', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.For, { from: alice }); // 400
      await governor.castVote(proposal.id, Vote.Against, { from: bob }); // 400
      await pastVotingEnd(proposal);
      assert.equal(await stateOf(proposal.id), State.Defeated);
    });

    it('Defeated: Against thắng', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.For, { from: dave }); // 50
      await governor.castVote(proposal.id, Vote.Against, { from: bob }); // 400
      await pastVotingEnd(proposal);
      assert.equal(await stateOf(proposal.id), State.Defeated);
    });

    it('Abstain tính vào quorum nhưng không tính vào thắng/thua', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.For, { from: dave }); // 50
      await governor.castVote(proposal.id, Vote.Abstain, { from: alice }); // 400 → 450 ≥ 200
      await pastVotingEnd(proposal);
      assert.equal(await stateOf(proposal.id), State.Succeeded, 'For 50 > Against 0, quorum đạt nhờ Abstain');
    });

    it('chỉ Abstain thì Defeated (For không lớn hơn Against)', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.Abstain, { from: alice });
      await pastVotingEnd(proposal);
      assert.equal(await stateOf(proposal.id), State.Defeated);
    });

    it('không ai vote thì Defeated', async () => {
      const proposal = await propose();
      await pastVotingEnd(proposal);
      assert.equal(await stateOf(proposal.id), State.Defeated);
    });

    it('quorumVotes = tổng cung tại snapshot × 20%', async () => {
      const { id } = await propose();
      assert.equal((await governor.quorumVotes(id)).toString(), tokens(200));
    });
  });

  describe('Execute', () => {
    it('proposal Succeeded: ai cũng execute được, state → Executed, emit event', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.For, { from: alice });
      await pastVotingEnd(proposal);

      const receipt = await governor.execute(proposal.id, { from: erin });
      assert.equal(findEvents(receipt, 'ProposalExecuted')[0].args.proposalId.toString(), '1');
      assert.equal(await stateOf(proposal.id), State.Executed);
    });

    it('không execute hai lần', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.For, { from: alice });
      await pastVotingEnd(proposal);
      await governor.execute(proposal.id);
      await expectRevert(governor.execute(proposal.id), 'GovernorProposalNotSucceeded');
    });

    it('không execute proposal Defeated', async () => {
      const proposal = await propose();
      await pastVotingEnd(proposal);
      await expectRevert(governor.execute(proposal.id), 'GovernorProposalNotSucceeded');
    });

    it('không execute proposal còn đang Active', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.For, { from: alice });
      await expectRevert(governor.execute(proposal.id), 'GovernorProposalNotSucceeded');
    });
  });

  describe('Cancel', () => {
    it('proposer hủy được khi Pending', async () => {
      const { id } = await propose(alice);
      const receipt = await governor.cancel(id, { from: alice });
      assert.equal(findEvents(receipt, 'ProposalCanceled').length, 1);
      assert.equal(await stateOf(id), State.Canceled);
    });

    it('owner hủy được proposal của người khác khi Active', async () => {
      const proposal = await propose(alice);
      await toVotingStart(proposal);
      await governor.cancel(proposal.id, { from: owner });
      assert.equal(await stateOf(proposal.id), State.Canceled);
    });

    it('người khác (không phải proposer/owner) không hủy được', async () => {
      const { id } = await propose(alice);
      await expectRevert(governor.cancel(id, { from: dave }), 'GovernorUnauthorizedCancel');
    });

    it('không hủy được sau khi kỳ bỏ phiếu kết thúc (owner không xóa được kết quả)', async () => {
      const proposal = await propose(alice);
      await pastVotingEnd(proposal);
      await expectRevert(governor.cancel(proposal.id, { from: owner }), 'GovernorCannotCancel');
    });

    it('không hủy hai lần', async () => {
      const { id } = await propose(alice);
      await governor.cancel(id, { from: alice });
      await expectRevert(governor.cancel(id, { from: alice }), 'GovernorCannotCancel');
    });

    it('proposal đã hủy không vote được', async () => {
      const proposal = await propose(alice);
      await governor.cancel(proposal.id, { from: alice });
      await toVotingStart(proposal);
      await expectRevert(
        governor.castVote(proposal.id, Vote.For, { from: alice }),
        'GovernorProposalNotActive'
      );
    });
  });

  describe('Hàm đọc', () => {
    it('state/getProposal/proposalVotes/quorumVotes revert với id không tồn tại', async () => {
      for (const id of [0, 7]) {
        await expectRevert(governor.state(id), 'GovernorNonexistentProposal');
        await expectRevert(governor.getProposal(id), 'GovernorNonexistentProposal');
        await expectRevert(governor.proposalVotes(id), 'GovernorNonexistentProposal');
        await expectRevert(governor.quorumVotes(id), 'GovernorNonexistentProposal');
      }
    });

    it('getVotingPowerForProposal: 0 trước khi snapshot qua, đúng số phiếu sau đó', async () => {
      const proposal = await propose();
      assert.equal((await governor.getVotingPowerForProposal(proposal.id, alice)).toString(), '0');

      await advanceToBlock(proposal.snapshot + 2);
      assert.equal((await governor.getVotingPowerForProposal(proposal.id, alice)).toString(), tokens(400));
      assert.equal((await governor.getVotingPowerForProposal(proposal.id, bob)).toString(), tokens(400));
      assert.equal((await governor.getVotingPowerForProposal(proposal.id, carol)).toString(), '0');
    });
  });

  describe('Quản trị tham số (chỉ owner)', () => {
    it('owner đổi được và có event', async () => {
      let receipt = await governor.setVotingDelay(3, { from: owner });
      assert.equal(findEvents(receipt, 'VotingDelayUpdated')[0].args.newValue.toString(), '3');
      receipt = await governor.setVotingPeriod(20, { from: owner });
      assert.equal(findEvents(receipt, 'VotingPeriodUpdated')[0].args.newValue.toString(), '20');
      receipt = await governor.setQuorumNumerator(50, { from: owner });
      assert.equal(findEvents(receipt, 'QuorumNumeratorUpdated')[0].args.newValue.toString(), '50');
    });

    it('người khác gọi thì revert OwnableUnauthorizedAccount', async () => {
      await expectRevert(governor.setVotingDelay(3, { from: alice }), 'OwnableUnauthorizedAccount');
      await expectRevert(governor.setVotingPeriod(3, { from: alice }), 'OwnableUnauthorizedAccount');
      await expectRevert(governor.setQuorumNumerator(3, { from: alice }), 'OwnableUnauthorizedAccount');
    });

    it('từ chối giá trị không hợp lệ', async () => {
      await expectRevert(governor.setVotingDelay(0, { from: owner }), 'GovernorInvalidVotingDelay');
      await expectRevert(governor.setVotingPeriod(0, { from: owner }), 'GovernorInvalidVotingPeriod');
      await expectRevert(governor.setQuorumNumerator(0, { from: owner }), 'GovernorInvalidQuorumNumerator');
      await expectRevert(governor.setQuorumNumerator(101, { from: owner }), 'GovernorInvalidQuorumNumerator');
    });

    it('tham số mới chỉ áp dụng cho proposal tạo SAU đó', async () => {
      const before = await propose();
      await governor.setVotingDelay(3, { from: owner });
      await governor.setVotingPeriod(20, { from: owner });
      const after = await propose();

      assert.equal(before.start - before.snapshot, 1);
      assert.equal(before.end - before.start, 9, 'proposal cũ giữ cửa sổ cũ');
      assert.equal(after.snapshot - after.receipt.receipt.blockNumber, 3, 'delay mới = 3');
      assert.equal(after.end - after.start, 19, 'period mới = 20 block');
    });

    it('votingPeriod/votingDelay quá lớn thì createProposal revert, không quay vòng uint48', async () => {
      const tooBig = web3.utils.toBN(2).pow(web3.utils.toBN(48)); // 2^48 không vừa uint48
      await governor.setVotingPeriod(tooBig, { from: owner });
      await expectRevert(
        governor.createProposal('Kỳ vote vô lý', { from: alice }),
        'SafeCastOverflowedUintDowncast'
      );

      await governor.setVotingPeriod(10, { from: owner });
      await governor.setVotingDelay(tooBig, { from: owner });
      await expectRevert(
        governor.createProposal('Delay vô lý', { from: alice }),
        'SafeCastOverflowedUintDowncast'
      );
    });

    it('đổi quorum KHÔNG lật được kết quả proposal đã kết thúc', async () => {
      const proposal = await propose();
      await toVotingStart(proposal);
      await governor.castVote(proposal.id, Vote.For, { from: alice }); // 400 ≥ 200 → Succeeded
      await pastVotingEnd(proposal);
      assert.equal(await stateOf(proposal.id), State.Succeeded);

      await governor.setQuorumNumerator(100, { from: owner }); // sẽ cần 1000 nếu áp dụng ngược
      assert.equal(await stateOf(proposal.id), State.Succeeded, 'kết quả giữ nguyên');
      assert.equal((await governor.quorumVotes(proposal.id)).toString(), tokens(200));

      const next = await propose();
      assert.equal((await governor.quorumVotes(next.id)).toString(), tokens(1000), 'proposal mới dùng 100%');
    });
  });
});
