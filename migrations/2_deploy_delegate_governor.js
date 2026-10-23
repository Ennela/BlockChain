/**
 * Migration 2 — DelegateGovernor
 *
 * Phải chạy sau migration 1: governor cần địa chỉ token, lấy qua `GovernanceToken.deployed()`.
 *
 * Tham số được chọn cho DEMO TRÊN MẠNG LOCAL, nơi block được đào tức thì:
 *   votingDelay  = 1 block   — phải >= 1, nếu không getPastVotes revert (xem constructor của governor)
 *   votingPeriod = 50 block  — đủ ngắn để demo, đủ dài để không hết hạn giữa buổi
 *   quorum       = 4%        — mức Compound/Uniswap dùng, con số có cơ sở để trình bày
 *
 * Trên mainnet các giá trị này sẽ là ~1 ngày và ~1 tuần tính theo block.
 */

const GovernanceToken = artifacts.require('GovernanceToken');
const DelegateGovernor = artifacts.require('DelegateGovernor');

const VOTING_DELAY = 1;
const VOTING_PERIOD = 50;
const QUORUM_PERCENT = 4;

module.exports = async function (deployer, network, accounts) {
  const owner = accounts[0];
  const token = await GovernanceToken.deployed();

  await deployer.deploy(
    DelegateGovernor,
    token.address,
    VOTING_DELAY,
    VOTING_PERIOD,
    QUORUM_PERCENT,
    owner
  );
  const governor = await DelegateGovernor.deployed();

  console.log('\n  DelegateGovernor');
  console.log('  ├─ address       :', governor.address);
  console.log('  ├─ token         :', token.address);
  console.log('  ├─ voting delay  :', VOTING_DELAY, 'block');
  console.log('  ├─ voting period :', VOTING_PERIOD, 'block');
  console.log('  ├─ quorum        :', QUORUM_PERCENT, '% tổng cung tại snapshot');
  console.log('  └─ owner         :', owner);
  console.log('\n  Bước tiếp theo: npm run demo\n');
};
