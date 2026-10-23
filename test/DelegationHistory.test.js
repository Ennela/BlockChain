/**
 * DelegationHistory — lịch sử thay đổi đại diện.
 *
 * Mỗi `it` ứng với một hàng của bảng kịch bản trong .claude/skills/delegation-history/SKILL.md.
 * Bất biến trung tâm: số record trong mảng == số event `DelegateChanged`, cùng thứ tự.
 */

const GovernanceToken = artifacts.require('GovernanceToken');
const { expectRevert, findEvents, tokens, ZERO_ADDRESS } = require('./helpers/evm');
const { signDelegation, farFutureExpiry } = require('./helpers/signatures');

contract('DelegationHistory', (accounts) => {
  const [owner, alice, bob, carol, relayer] = accounts;
  let token;

  beforeEach(async () => {
    token = await GovernanceToken.new(owner, tokens(1000));
    await token.transfer(alice, tokens(100), { from: owner });
  });

  /** Block number và timestamp của block chứa một transaction. */
  async function blockOf(receipt) {
    const block = await web3.eth.getBlock(receipt.receipt.blockNumber);
    return { number: Number(block.number), timestamp: Number(block.timestamp) };
  }

  /** Số event DelegateChanged của `delegator` kể từ đầu chuỗi. */
  async function delegateChangedLogs(delegator) {
    return token.getPastEvents('DelegateChanged', {
      filter: { delegator },
      fromBlock: 0,
      toBlock: 'latest',
    });
  }

  describe('Các kịch bản ghi record', () => {
    it('lần đầu ủy quyền cho người khác: previous = address(0)', async () => {
      const receipt = await token.delegate(bob, { from: alice });
      const { number, timestamp } = await blockOf(receipt);

      assert.equal((await token.getDelegationCount(alice)).toString(), '1');
      const record = await token.getDelegationRecord(alice, 0);
      assert.equal(record.previousDelegate, ZERO_ADDRESS);
      assert.equal(record.newDelegate, bob);
      assert.equal(Number(record.blockNumber), number);
      assert.equal(Number(record.timestamp), timestamp);
    });

    it('lần đầu tự ủy quyền: new = chính mình', async () => {
      await token.delegate(alice, { from: alice });

      const record = await token.getLatestDelegation(alice);
      assert.equal(record.previousDelegate, ZERO_ADDRESS);
      assert.equal(record.newDelegate, alice);
    });

    it('đổi đại diện A → B: previous là đại diện cũ, thứ tự cũ → mới', async () => {
      await token.delegate(bob, { from: alice });
      await token.delegate(carol, { from: alice });

      const history = await token.getDelegationHistory(alice);
      assert.equal(history.length, 2);
      assert.equal(history[0].previousDelegate, ZERO_ADDRESS);
      assert.equal(history[0].newDelegate, bob);
      assert.equal(history[1].previousDelegate, bob);
      assert.equal(history[1].newDelegate, carol);
      assert.isAtLeast(Number(history[1].blockNumber), Number(history[0].blockNumber));
    });

    it('ủy quyền lại đúng người đang là đại diện VẪN ghi một record', async () => {
      await token.delegate(bob, { from: alice });
      await token.delegate(bob, { from: alice });

      assert.equal((await token.getDelegationCount(alice)).toString(), '2');
      const latest = await token.getLatestDelegation(alice);
      assert.equal(latest.previousDelegate, bob);
      assert.equal(latest.newDelegate, bob);
      // OZ cũng emit DelegateChanged ở lần này — đây là lý do ta không được bỏ qua record.
      assert.equal((await delegateChangedLogs(alice)).length, 2);
    });

    it('hủy ủy quyền (về address(0)) được ghi lại', async () => {
      await token.delegate(bob, { from: alice });
      await token.delegate(ZERO_ADDRESS, { from: alice });

      const latest = await token.getLatestDelegation(alice);
      assert.equal(latest.previousDelegate, bob);
      assert.equal(latest.newDelegate, ZERO_ADDRESS);
      assert.equal(await token.delegates(alice), ZERO_ADDRESS);
      // history phân biệt được "chưa từng delegate" với "đã hủy"
      assert.isTrue(await token.hasDelegationHistory(alice));
      assert.isFalse(await token.hasDelegationHistory(carol));
    });

    it('transfer, mint không tạo record — chúng chỉ đổi checkpoint', async () => {
      await token.delegate(bob, { from: alice });
      await token.transfer(alice, tokens(10), { from: owner });
      await token.mint(alice, tokens(10), { from: owner });
      await token.transfer(carol, tokens(5), { from: alice });

      assert.equal((await token.getDelegationCount(alice)).toString(), '1');
      assert.equal((await token.getDelegationCount(carol)).toString(), '0');
      assert.equal((await token.totalDelegationChanges()).toString(), '1');
    });

    it('lịch sử của mỗi địa chỉ tách biệt nhau', async () => {
      await token.delegate(bob, { from: alice });
      await token.delegate(carol, { from: owner });

      assert.equal((await token.getDelegationCount(alice)).toString(), '1');
      assert.equal((await token.getDelegationCount(owner)).toString(), '1');
      assert.equal((await token.getLatestDelegation(alice)).newDelegate, bob);
      assert.equal((await token.getLatestDelegation(owner)).newDelegate, carol);
      assert.equal((await token.totalDelegationChanges()).toString(), '2');
    });
  });

  describe('Event DelegationRecorded', () => {
    it('mang đúng recordIndex, block và timestamp', async () => {
      await token.delegate(bob, { from: alice });
      const receipt = await token.delegate(carol, { from: alice });
      const { number, timestamp } = await blockOf(receipt);

      const [event] = findEvents(receipt, 'DelegationRecorded');
      assert.equal(event.args.delegator, alice);
      assert.equal(event.args.previousDelegate, bob);
      assert.equal(event.args.newDelegate, carol);
      assert.equal(event.args.recordIndex.toString(), '1');
      assert.equal(Number(event.args.blockNumber), number);
      assert.equal(Number(event.args.timestamp), timestamp);
    });
  });

  describe('Bất biến: mảng history == chuỗi event DelegateChanged', () => {
    it('khớp từng phần tử, cùng thứ tự, qua một chuỗi thao tác hỗn hợp', async () => {
      await token.delegate(alice, { from: alice }); // tự
      await token.delegate(bob, { from: alice }); // đổi
      await token.delegate(bob, { from: alice }); // lại cùng người
      await token.delegate(ZERO_ADDRESS, { from: alice }); // hủy
      await token.delegate(carol, { from: alice }); // sau khi hủy

      const history = await token.getDelegationHistory(alice);
      const logs = await delegateChangedLogs(alice);

      assert.equal(history.length, logs.length, 'cùng số phần tử');
      history.forEach((record, i) => {
        assert.equal(record.previousDelegate, logs[i].returnValues.fromDelegate, `from #${i}`);
        assert.equal(record.newDelegate, logs[i].returnValues.toDelegate, `to #${i}`);
      });
    });

    it('previous của record n+1 luôn bằng new của record n', async () => {
      for (const target of [bob, carol, alice, bob, ZERO_ADDRESS, carol]) {
        await token.delegate(target, { from: alice });
      }
      const history = await token.getDelegationHistory(alice);
      for (let i = 1; i < history.length; i++) {
        assert.equal(history[i].previousDelegate, history[i - 1].newDelegate, `chuỗi #${i}`);
      }
    });
  });

  describe('delegateBySig — entry point thứ hai', () => {
    it('ghi record cho NGƯỜI KÝ, không phải người gửi transaction', async () => {
      const expiry = farFutureExpiry();
      const nonce = await token.nonces(alice);
      const { v, r, s } = await signDelegation(token, alice, bob, nonce, expiry);

      await token.delegateBySig(bob, nonce, expiry, v, r, s, { from: relayer });

      assert.equal(await token.delegates(alice), bob);
      assert.equal((await token.getDelegationCount(alice)).toString(), '1');
      assert.equal((await token.getDelegationCount(relayer)).toString(), '0');
      const record = await token.getLatestDelegation(alice);
      assert.equal(record.previousDelegate, ZERO_ADDRESS);
      assert.equal(record.newDelegate, bob);
      assert.equal((await token.getVotes(bob)).toString(), tokens(100));
    });

    it('history vẫn khớp event khi trộn delegate() và delegateBySig()', async () => {
      await token.delegate(bob, { from: alice });

      const expiry = farFutureExpiry();
      const nonce = await token.nonces(alice);
      const { v, r, s } = await signDelegation(token, alice, carol, nonce, expiry);
      await token.delegateBySig(carol, nonce, expiry, v, r, s, { from: relayer });

      const history = await token.getDelegationHistory(alice);
      assert.equal(history.length, 2);
      assert.equal(history[1].previousDelegate, bob, 'previous đọc đúng cả ở đường chữ ký');
      assert.equal(history[1].newDelegate, carol);
      assert.equal((await delegateChangedLogs(alice)).length, history.length);
    });

    it('chữ ký đã dùng không dùng lại được (replay)', async () => {
      const expiry = farFutureExpiry();
      const nonce = await token.nonces(alice);
      const { v, r, s } = await signDelegation(token, alice, bob, nonce, expiry);

      await token.delegateBySig(bob, nonce, expiry, v, r, s, { from: relayer });
      await expectRevert(
        token.delegateBySig(bob, nonce, expiry, v, r, s, { from: relayer }),
        'InvalidAccountNonce'
      );
      assert.equal((await token.getDelegationCount(alice)).toString(), '1', 'không thêm record');
    });

    it('chữ ký hết hạn thì revert và không ghi record', async () => {
      const expiry = 1; // đã qua từ lâu
      const nonce = await token.nonces(alice);
      const { v, r, s } = await signDelegation(token, alice, bob, nonce, expiry);

      await expectRevert(
        token.delegateBySig(bob, nonce, expiry, v, r, s, { from: relayer }),
        'VotesExpiredSignature'
      );
      assert.equal((await token.getDelegationCount(alice)).toString(), '0');
    });
  });

  describe('Getter và phân trang', () => {
    beforeEach(async () => {
      // 5 record: 0x0→bob, bob→carol, carol→bob, bob→carol, carol→bob
      for (const target of [bob, carol, bob, carol, bob]) {
        await token.delegate(target, { from: alice });
      }
    });

    it('getDelegationCount khớp độ dài getDelegationHistory', async () => {
      assert.equal((await token.getDelegationCount(alice)).toString(), '5');
      assert.equal((await token.getDelegationHistory(alice)).length, 5);
    });

    it('địa chỉ chưa từng delegate: lịch sử rỗng', async () => {
      assert.equal((await token.getDelegationHistory(carol)).length, 0);
    });

    it('getDelegationRecord vượt biên thì revert', async () => {
      await expectRevert(token.getDelegationRecord(alice, 5));
    });

    it('getLatestDelegation revert khi chưa có history', async () => {
      await expectRevert(token.getLatestDelegation(carol), 'DelegationHistoryNoRecords');
    });

    it('phân trang: lấy từng trang và ghép lại bằng toàn bộ lịch sử', async () => {
      const full = await token.getDelegationHistory(alice);
      const pages = [];
      // Tiến offset theo số record THỰC nhận (không theo limit) để không vượt độ dài; trang rỗng là hết.
      for (let offset = 0; ; offset += 2) {
        const page = await token.getDelegationHistoryPaginated(alice, offset, 2);
        if (page.length === 0) break;
        pages.push(...page);
        if (page.length < 2) break;
      }
      assert.equal(pages.length, full.length);
      pages.forEach((record, i) => assert.equal(record.newDelegate, full[i].newDelegate));
    });

    it('limit lớn hơn phần còn lại thì trả phần còn lại', async () => {
      const page = await token.getDelegationHistoryPaginated(alice, 3, 100);
      assert.equal(page.length, 2);
    });

    it('offset == độ dài thì trả mảng rỗng', async () => {
      assert.equal((await token.getDelegationHistoryPaginated(alice, 5, 10)).length, 0);
    });

    it('offset > độ dài thì revert DelegationHistoryInvalidOffset', async () => {
      await expectRevert(
        token.getDelegationHistoryPaginated(alice, 6, 10),
        'DelegationHistoryInvalidOffset'
      );
    });

    it('limit = 0 thì revert DelegationHistoryZeroLimit', async () => {
      await expectRevert(
        token.getDelegationHistoryPaginated(alice, 0, 0),
        'DelegationHistoryZeroLimit'
      );
    });
  });
});
