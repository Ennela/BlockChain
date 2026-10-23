/**
 * Migration 1 — GovernanceToken
 *
 * Mint toàn bộ initial supply cho deployer, rồi deployer tự delegate để có voting power ngay.
 * Bước self-delegate là cố ý và cần thiết: không có nó, deployer giữ 1 triệu token nhưng
 * `getVotes()` trả về 0 và không tạo được proposal nào. Xem ghi chú "TOKEN ≠ VOTING POWER"
 * trong contracts/GovernanceToken.sol.
 */

const GovernanceToken = artifacts.require('GovernanceToken');

// 1 triệu token, khớp MAX_SUPPLY trong contract.
const INITIAL_SUPPLY = web3.utils.toWei('1000000', 'ether');

module.exports = async function (deployer, network, accounts) {
  const owner = accounts[0];

  await deployer.deploy(GovernanceToken, owner, INITIAL_SUPPLY);
  const token = await GovernanceToken.deployed();

  // Kích hoạt voting power cho owner.
  await token.delegate(owner, { from: owner });

  const votes = await token.getVotes(owner);
  const historyCount = await token.getDelegationCount(owner);

  console.log('\n  GovernanceToken');
  console.log('  ├─ address        :', token.address);
  console.log('  ├─ owner          :', owner);
  console.log('  ├─ total supply   :', web3.utils.fromWei(INITIAL_SUPPLY), 'DAOT');
  console.log('  ├─ owner votes    :', web3.utils.fromWei(votes), '(sau khi self-delegate)');
  console.log('  └─ history records:', historyCount.toString(), '\n');
};
