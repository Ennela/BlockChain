/**
 * GovernanceToken — ERC-20, delegation và voting power.
 *
 * Trọng tâm: phân biệt cho được **balance token** với **voting power**, và chứng minh voting power
 * dịch chuyển đúng khi delegate / chuyển token.
 */

const GovernanceToken = artifacts.require('GovernanceToken');
const {
  advanceBlocks,
  currentBlock,
  expectRevert,
  tokens,
  ZERO_ADDRESS,
} = require('./helpers/evm');

contract('GovernanceToken', (accounts) => {
  const [owner, alice, bob, carol] = accounts;
  const INITIAL_SUPPLY = tokens(1000);

  let token;

  beforeEach(async () => {
    token = await GovernanceToken.new(owner, INITIAL_SUPPLY);
  });

  describe('Khởi tạo', () => {
    it('đặt đúng name, symbol, decimals', async () => {
      assert.equal(await token.name(), 'DelegateDAO Token');
      assert.equal(await token.symbol(), 'DAOT');
      assert.equal((await token.decimals()).toString(), '18');
    });

    it('mint initial supply cho owner', async () => {
      assert.equal((await token.totalSupply()).toString(), INITIAL_SUPPLY);
      assert.equal((await token.balanceOf(owner)).toString(), INITIAL_SUPPLY);
    });

    it('đặt owner theo tham số, không phải msg.sender', async () => {
      // Deploy từ alice nhưng chỉ định bob làm owner.
      const custom = await GovernanceToken.new(bob, tokens(10), { from: alice });
      assert.equal(await custom.owner(), bob);
      assert.equal((await custom.balanceOf(bob)).toString(), tokens(10));
    });

    it('cho phép initial supply bằng 0', async () => {
      const empty = await GovernanceToken.new(owner, 0);
      assert.equal((await empty.totalSupply()).toString(), '0');
    });

    it('revert nếu initial supply vượt MAX_SUPPLY', async () => {
      await expectRevert(
        GovernanceToken.new(owner, tokens(1000001)),
        'GovernanceTokenMaxSupplyExceeded'
      );
    });
  });

  describe('Token KHÁC voting power — điểm dễ nhầm nhất', () => {
    it('owner có token nhưng voting power = 0 khi chưa delegate', async () => {
      assert.equal((await token.balanceOf(owner)).toString(), INITIAL_SUPPLY);
      assert.equal((await token.getVotes(owner)).toString(), '0');
      assert.equal(await token.delegates(owner), ZERO_ADDRESS);
    });

    it('nhận token cũng không tự sinh voting power', async () => {
      await token.transfer(alice, tokens(100), { from: owner });
      assert.equal((await token.balanceOf(alice)).toString(), tokens(100));
      assert.equal((await token.getVotes(alice)).toString(), '0');
    });

    it('self-delegate kích hoạt voting power bằng balance', async () => {
      await token.transfer(alice, tokens(100), { from: owner });
      await token.delegate(alice, { from: alice });
      assert.equal((await token.getVotes(alice)).toString(), tokens(100));
    });
  });

  describe('Delegation và voting power', () => {
    beforeEach(async () => {
      await token.transfer(alice, tokens(100), { from: owner });
      await token.transfer(bob, tokens(50), { from: owner });
    });

    it('ủy quyền cho người khác chuyển phiếu, không chuyển token', async () => {
      await token.delegate(bob, { from: alice });

      assert.equal(await token.delegates(alice), bob);
      assert.equal((await token.getVotes(bob)).toString(), tokens(100), 'bob nhận phiếu của alice');
      assert.equal((await token.getVotes(alice)).toString(), '0', 'alice không còn phiếu');
      assert.equal((await token.balanceOf(alice)).toString(), tokens(100), 'token vẫn ở alice');
      assert.equal((await token.balanceOf(bob)).toString(), tokens(50), 'bob không nhận token');
    });

    it('một đại diện cộng dồn phiếu từ nhiều người', async () => {
      await token.delegate(carol, { from: alice }); // 100
      await token.delegate(carol, { from: bob }); //  50
      assert.equal((await token.getVotes(carol)).toString(), tokens(150));
    });

    it('đại diện tự delegate thì phiếu của chính mình cộng thêm', async () => {
      await token.delegate(bob, { from: alice }); // bob: 100 (của alice)
      await token.delegate(bob, { from: bob }); // bob: 100 + 50 của chính mình
      assert.equal((await token.getVotes(bob)).toString(), tokens(150));
    });

    it('đổi đại diện chuyển toàn bộ phiếu, không mất mát', async () => {
      await token.delegate(bob, { from: alice });
      await token.delegate(carol, { from: alice });

      assert.equal((await token.getVotes(bob)).toString(), '0');
      assert.equal((await token.getVotes(carol)).toString(), tokens(100));
      assert.equal(await token.delegates(alice), carol);
    });

    it('delegate về address(0) thì hủy quyền biểu quyết', async () => {
      await token.delegate(bob, { from: alice });
      assert.equal((await token.getVotes(bob)).toString(), tokens(100));

      await token.delegate(ZERO_ADDRESS, { from: alice });
      assert.equal((await token.getVotes(bob)).toString(), '0');
      assert.equal(await token.delegates(alice), ZERO_ADDRESS);
    });

    it('chuyển token cập nhật phiếu của đại diện tương ứng', async () => {
      await token.delegate(carol, { from: alice }); // carol giữ 100 phiếu của alice
      await token.transfer(bob, tokens(40), { from: alice });

      assert.equal((await token.getVotes(carol)).toString(), tokens(60), 'giảm 40');
      assert.equal((await token.getVotes(bob)).toString(), '0', 'bob chưa delegate');
    });

    it('emit DelegateChanged với đúng from/to', async () => {
      const receipt = await token.delegate(bob, { from: alice });
      const event = receipt.logs.find((log) => log.event === 'DelegateChanged');

      assert.isDefined(event, 'phải emit DelegateChanged');
      assert.equal(event.args.delegator, alice);
      assert.equal(event.args.fromDelegate, ZERO_ADDRESS);
      assert.equal(event.args.toDelegate, bob);
    });
  });

  describe('Checkpoint voting power trong quá khứ', () => {
    it('getPastVotes trả về giá trị tại block đã qua', async () => {
      await token.transfer(alice, tokens(100), { from: owner });
      await token.delegate(alice, { from: alice });

      const blockAfterDelegate = await currentBlock();
      await advanceBlocks(1);

      // Tăng balance của alice → phiếu hiện tại tăng, nhưng quá khứ không đổi.
      await token.transfer(alice, tokens(100), { from: owner });
      await advanceBlocks(1);

      assert.equal((await token.getVotes(alice)).toString(), tokens(200), 'hiện tại');
      assert.equal(
        (await token.getPastVotes(alice, blockAfterDelegate)).toString(),
        tokens(100),
        'quá khứ không bị ghi đè'
      );
    });

    it('getPastVotes revert nếu block chưa qua', async () => {
      const future = (await currentBlock()) + 100;
      await expectRevert(token.getPastVotes(alice, future), 'ERC5805FutureLookup');
    });

    it('getPastTotalSupply theo dõi tổng cung theo block', async () => {
      const before = await currentBlock();
      await advanceBlocks(1);

      await token.mint(alice, tokens(500), { from: owner });
      await advanceBlocks(1);

      assert.equal((await token.getPastTotalSupply(before)).toString(), INITIAL_SUPPLY);
      assert.equal((await token.totalSupply()).toString(), tokens(1500));
    });
  });

  describe('Mint và access control', () => {
    it('owner mint được', async () => {
      await token.mint(alice, tokens(500), { from: owner });
      assert.equal((await token.balanceOf(alice)).toString(), tokens(500));
      assert.equal((await token.totalSupply()).toString(), tokens(1500));
    });

    it('người khác mint thì revert', async () => {
      await expectRevert(
        token.mint(alice, tokens(500), { from: alice }),
        'OwnableUnauthorizedAccount'
      );
    });

    it('mint vượt MAX_SUPPLY thì revert', async () => {
      await expectRevert(
        token.mint(alice, tokens(999001), { from: owner }),
        'GovernanceTokenMaxSupplyExceeded'
      );
    });

    it('mint tới address(0) thì revert', async () => {
      await expectRevert(
        token.mint(ZERO_ADDRESS, tokens(1), { from: owner }),
        'GovernanceTokenInvalidReceiver'
      );
    });

    it('mint cộng phiếu cho đại diện hiện tại của người nhận', async () => {
      await token.delegate(carol, { from: alice });
      await token.mint(alice, tokens(200), { from: owner });
      assert.equal((await token.getVotes(carol)).toString(), tokens(200));
    });

    it('remainingMintableSupply tính đúng', async () => {
      assert.equal((await token.remainingMintableSupply()).toString(), tokens(999000));
      await token.mint(alice, tokens(1000), { from: owner });
      assert.equal((await token.remainingMintableSupply()).toString(), tokens(998000));
    });
  });

  describe('ERC-20 cơ bản', () => {
    it('transfer và approve/transferFrom hoạt động', async () => {
      await token.transfer(alice, tokens(100), { from: owner });
      assert.equal((await token.balanceOf(alice)).toString(), tokens(100));

      await token.approve(bob, tokens(30), { from: alice });
      assert.equal((await token.allowance(alice, bob)).toString(), tokens(30));

      await token.transferFrom(alice, carol, tokens(30), { from: bob });
      assert.equal((await token.balanceOf(carol)).toString(), tokens(30));
      assert.equal((await token.balanceOf(alice)).toString(), tokens(70));
    });

    it('transfer vượt balance thì revert', async () => {
      await expectRevert(
        token.transfer(bob, tokens(1), { from: alice }),
        'ERC20InsufficientBalance'
      );
    });
  });

  describe('Clock mode (ERC-6372)', () => {
    it('dùng block number làm đơn vị thời gian', async () => {
      assert.equal(await token.CLOCK_MODE(), 'mode=blocknumber&from=default');
      const clock = Number(await token.clock());
      assert.closeTo(clock, await currentBlock(), 1);
    });
  });
});
