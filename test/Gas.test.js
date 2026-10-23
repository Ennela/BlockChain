/**
 * Gas — đo chi phí THẬT của lịch sử on-chain, thay cho con số ước lượng.
 *
 * So `GovernanceToken` (có DelegationHistory) với `PlainVotesToken` (cùng OZ, không history) trong
 * cùng một kịch bản; hiệu số chính là phần history. Test in bảng ra console để dán vào tài liệu và
 * chỉ khẳng định sanity (history tốn thêm gas, nhưng không phi lý) — không khóa số cụ thể vì gas
 * đổi theo phiên bản compiler/EVM.
 */

const GovernanceToken = artifacts.require('GovernanceToken');
const PlainVotesToken = artifacts.require('PlainVotesToken');
const { tokens } = require('./helpers/evm');

contract('Gas — chi phí lịch sử delegation', (accounts) => {
  const [owner, alice, bob, carol] = accounts;

  async function measure(token) {
    await token.transfer(alice, tokens(100), { from: owner });
    const first = await token.delegate(bob, { from: alice }); //   0x0 → bob   (lần đầu)
    const change = await token.delegate(carol, { from: alice }); // bob → carol (đổi)
    const again = await token.delegate(carol, { from: alice }); //  carol → carol (lại cùng người)
    return {
      first: first.receipt.gasUsed,
      change: change.receipt.gasUsed,
      again: again.receipt.gasUsed,
    };
  }

  it('đo gas delegate có / không có history', async () => {
    const withHistory = await measure(await GovernanceToken.new(owner, tokens(1000)));
    const plain = await measure(await PlainVotesToken.new(owner, tokens(1000)));

    const rows = [
      ['delegate lần đầu (0x0 → bob)', 'first'],
      ['đổi đại diện (bob → carol)', 'change'],
      ['ủy quyền lại cùng người', 'again'],
    ];
    console.log('\n    Gas của delegate() — OZ 5.1.0, solc 0.8.24, optimizer 200 runs');
    console.log('    ' + 'kịch bản'.padEnd(32) + 'có history'.padStart(12) + 'không history'.padStart(15) + 'chênh lệch'.padStart(12));
    for (const [label, key] of rows) {
      const diff = withHistory[key] - plain[key];
      console.log(
        '    ' + label.padEnd(32) + String(withHistory[key]).padStart(12) +
          String(plain[key]).padStart(15) + String(diff).padStart(12)
      );
      assert.isAbove(diff, 0, `${label}: history phải tốn thêm gas`);
      assert.isBelow(diff, 100000, `${label}: chênh lệch vượt mức hợp lý`);
    }
    console.log('');
  });
});
