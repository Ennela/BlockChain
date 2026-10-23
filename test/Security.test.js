/**
 * Security — cố ý PHÁ các bất biến của DelegateDAO.
 *
 * Mỗi test mô tả một cuộc tấn công và khẳng định nó thất bại (hoặc không có lợi).
 * Đối chiếu với bảng rủi ro R1–R9 trong docs/ARCHITECTURE.md §7.
 *
 * Fixture giống DelegateGovernor.test.js: alice 400, bob 300, carol 100 (→ bob), dave 50, owner 150;
 * tổng 1000 DAOT, quorum 20%, votingDelay 1, votingPeriod 10.
 */

const GovernanceToken = artifacts.require('GovernanceToken');
const DelegateGovernor = artifacts.require('DelegateGovernor');
const {
  advanceToBlock,
  expectRevert,
  findEvents,
  tokens,
  ZERO_ADDRESS,
} = require('./helpers/evm');
const { signDelegation, signPermit, farFutureExpiry } = require('./helpers/signatures');

const Vote = { Against: 0, For: 1, Abstain: 2 };

contract('Security', (accounts) => {
  const [owner, alice, bob, carol, dave, erin, relayer] = accounts;
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

  /** Tạo proposal rồi đẩy chain tới sau block snapshot; mọi hành động tiếp theo là "sau snapshot". */
  async function proposalAfterSnapshot() {
    const receipt = await governor.createProposal('Đề xuất để tấn công', { from: alice });
    const id = findEvents(receipt, 'ProposalCreated')[0].args.proposalId;
    const p = await governor.getProposal(id);
    await advanceToBlock(Number(p.voteStart)); // tx kế tiếp ở voteStart + 1, đã qua snapshot
    return id;
  }

  describe('R3 — Snapshot: không nhân đôi hay mua phiếu sau thời điểm chốt', () => {
    it('vote rồi chuyển token sang ví mới: ví mới không vote được, tổng phiếu không đổi', async () => {
      const id = await proposalAfterSnapshot();
      await governor.castVote(id, Vote.For, { from: alice });

      await token.transfer(erin, tokens(400), { from: alice });
      await token.delegate(erin, { from: erin });
      assert.equal((await token.getVotes(erin)).toString(), tokens(400), 'erin có phiếu HIỆN TẠI');

      await expectRevert(governor.castVote(id, Vote.For, { from: erin }), 'GovernorNoVotingPower');
      const votes = await governor.proposalVotes(id);
      assert.equal(votes.forVotes.toString(), tokens(400), 'vẫn 400, không phải 800');
    });

    it('phiếu đã ghi không đổi dù chủ phiếu chuyển hết token đi', async () => {
      const id = await proposalAfterSnapshot();
      await governor.castVote(id, Vote.For, { from: alice });
      await token.transfer(erin, tokens(400), { from: alice });

      const receipt = await governor.getReceipt(id, alice);
      assert.equal(receipt.votes.toString(), tokens(400));
      assert.equal((await governor.proposalVotes(id)).forVotes.toString(), tokens(400));
    });

    it('được ủy quyền SAU snapshot thì không có quyền vote', async () => {
      const id = await proposalAfterSnapshot();
      await token.delegate(erin, { from: alice }); // alice chuyển phiếu cho erin sau snapshot

      assert.equal((await token.getVotes(erin)).toString(), tokens(400));
      await expectRevert(governor.castVote(id, Vote.For, { from: erin }), 'GovernorNoVotingPower');
    });

    it('đổi đại diện sau snapshot không nhân đôi: tổng phiếu tối đa bằng tổng token đã chốt', async () => {
      const id = await proposalAfterSnapshot();
      await governor.castVote(id, Vote.For, { from: alice }); // 400 (snapshot: alice tự giữ)
      await token.delegate(bob, { from: alice }); // alice đẩy phiếu sang bob SAU snapshot
      await governor.castVote(id, Vote.For, { from: bob }); // bob vẫn chỉ 300 + 100 theo snapshot

      const receipt = await governor.getReceipt(id, bob);
      assert.equal(receipt.votes.toString(), tokens(400), 'bob không nhận thêm 400 của alice');
      assert.equal((await governor.proposalVotes(id)).forVotes.toString(), tokens(800));
    });

    it('mint sau khi tạo proposal không đổi quorum và không cho quyền vote', async () => {
      const receipt = await governor.createProposal('Mint giữa kỳ', { from: alice });
      const id = findEvents(receipt, 'ProposalCreated')[0].args.proposalId;
      const p = await governor.getProposal(id);
      await advanceToBlock(Number(p.voteStart));

      await token.mint(erin, tokens(900), { from: owner });
      await token.delegate(erin, { from: erin });

      assert.equal((await governor.quorumVotes(id)).toString(), tokens(200), 'quorum chốt ở 1000 × 20%');
      await expectRevert(governor.castVote(id, Vote.For, { from: erin }), 'GovernorNoVotingPower');
    });
  });

  describe('Kiểm soát truy cập — bề mặt tấn công', () => {
    const writeFunctions = (contractAbi) =>
      contractAbi
        .filter((e) => e.type === 'function' && !['view', 'pure'].includes(e.stateMutability))
        .map((e) => e.name)
        .sort();

    it('GovernanceToken chỉ có đúng các hàm ghi dự kiến — không có đường ghi history từ ngoài', () => {
      // Nếu ai đó thêm một hàm public ghi vào history, danh sách này đổi và test đỏ.
      assert.deepEqual(writeFunctions(GovernanceToken.abi), [
        'approve',
        'delegate',
        'delegateBySig',
        'mint',
        'permit',
        'renounceOwnership',
        'transfer',
        'transferFrom',
        'transferOwnership',
      ]);
    });

    it('DelegateGovernor chỉ có đúng các hàm ghi dự kiến', () => {
      assert.deepEqual(writeFunctions(DelegateGovernor.abi), [
        'cancel',
        'castVote',
        'castVoteWithReason',
        'createProposal',
        'execute',
        'renounceOwnership',
        'setQuorumNumerator',
        'setVotingDelay',
        'setVotingPeriod',
        'transferOwnership',
      ]);
    });

    it('người ngoài không chuyển quyền owner hay từ bỏ quyền owner', async () => {
      await expectRevert(token.transferOwnership(erin, { from: erin }), 'OwnableUnauthorizedAccount');
      await expectRevert(token.renounceOwnership({ from: erin }), 'OwnableUnauthorizedAccount');
      await expectRevert(governor.transferOwnership(erin, { from: erin }), 'OwnableUnauthorizedAccount');
    });

    it('owner mới (sau transferOwnership) mới mint được, owner cũ thì không', async () => {
      await token.transferOwnership(erin, { from: owner });
      await token.mint(dave, tokens(1), { from: erin });
      await expectRevert(token.mint(dave, tokens(1), { from: owner }), 'OwnableUnauthorizedAccount');
    });
  });

  describe('R2 — delegateBySig', () => {
    it('chữ ký cho token A không dùng được trên token B (domain gắn với địa chỉ contract)', async () => {
      const other = await GovernanceToken.new(owner, tokens(1000));
      await other.transfer(alice, tokens(100), { from: owner });

      const expiry = farFutureExpiry();
      const { v, r, s } = await signDelegation(token, alice, bob, 0, expiry);
      await other.delegateBySig(bob, 0, expiry, v, r, s, { from: relayer });

      // Chữ ký phục hồi ra một địa chỉ ngẫu nhiên, KHÔNG phải alice.
      assert.equal(await other.delegates(alice), ZERO_ADDRESS, 'alice không bị ép delegate');
      assert.equal((await other.getDelegationCount(alice)).toString(), '0');
    });

    it('nonce của permit và delegateBySig là MỘT chuỗi: permit làm vô hiệu chữ ký delegate cũ', async () => {
      const expiry = farFutureExpiry();
      const delegation = await signDelegation(token, alice, bob, 0, expiry);
      const permit = await signPermit(token, alice, erin, tokens(1), 0, expiry);

      await token.permit(alice, erin, tokens(1), expiry, permit.v, permit.r, permit.s, {
        from: relayer,
      });
      assert.equal((await token.nonces(alice)).toString(), '1', 'permit đã dùng nonce 0');

      await expectRevert(
        token.delegateBySig(bob, 0, expiry, delegation.v, delegation.r, delegation.s, {
          from: relayer,
        }),
        'InvalidAccountNonce'
      );
      assert.equal(await token.delegates(alice), alice, 'delegation không đổi');
    });

    it('người relay không thể đổi người nhận ủy quyền (đổi delegatee làm hỏng chữ ký)', async () => {
      const expiry = farFutureExpiry();
      const { v, r, s } = await signDelegation(token, alice, bob, 0, expiry);

      // relayer thay bob bằng chính mình: chữ ký phục hồi ra địa chỉ khác alice.
      await token.delegateBySig(relayer, 0, expiry, v, r, s, { from: relayer });
      assert.equal(await token.delegates(alice), alice, 'alice vẫn tự ủy quyền');
      assert.equal((await token.getVotes(relayer)).toString(), '0');
    });
  });

  describe('R1 — Bất biến qua chuỗi thao tác hỗn hợp (xác định, không ngẫu nhiên thật)', () => {
    it('history == DelegateChanged cho mọi địa chỉ, và phiếu được bảo toàn', async () => {
      const users = [alice, bob, carol, dave];
      const targets = [alice, bob, carol, dave, ZERO_ADDRESS];

      // LCG cố định → chuỗi thao tác tái lập được từng lần chạy.
      let seed = 12345;
      const next = (n) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed % n;
      };

      for (let step = 0; step < 36; step++) {
        const user = users[next(users.length)];
        const target = targets[next(targets.length)];
        const kind = next(4);

        if (kind === 0) {
          // 1 token mỗi lần: người nhỏ nhất (dave, 50) không thể cạn trong 36 bước.
          await token.transfer(users[next(users.length)], tokens(1), { from: user });
        } else if (kind === 1) {
          const expiry = farFutureExpiry();
          const nonce = await token.nonces(user);
          const { v, r, s } = await signDelegation(token, user, target, nonce, expiry);
          await token.delegateBySig(target, nonce, expiry, v, r, s, { from: relayer });
        } else {
          await token.delegate(target, { from: user });
        }
      }

      for (const account of [...users, owner, relayer]) {
        const history = await token.getDelegationHistory(account);
        const logs = await token.getPastEvents('DelegateChanged', {
          filter: { delegator: account },
          fromBlock: 0,
          toBlock: 'latest',
        });
        assert.equal(history.length, logs.length, `số phần tử của ${account}`);
        history.forEach((record, i) => {
          assert.equal(record.previousDelegate, logs[i].returnValues.fromDelegate);
          assert.equal(record.newDelegate, logs[i].returnValues.toDelegate);
        });
      }

      // Bảo toàn: phiếu của một đại diện == tổng balance của những người đang ủy quyền cho họ.
      const everyone = [owner, ...users, relayer];
      for (const delegatee of everyone) {
        let expected = web3.utils.toBN(0);
        for (const holder of everyone) {
          if ((await token.delegates(holder)) === delegatee) {
            expected = expected.add(await token.balanceOf(holder));
          }
        }
        assert.equal((await token.getVotes(delegatee)).toString(), expected.toString(), delegatee);
      }
    });
  });
});
