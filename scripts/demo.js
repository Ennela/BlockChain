/**
 * Demo đầu-cuối DelegateDAO — chạy trên Ganache sau khi đã deploy:
 *
 *   npm run ganache        (terminal 1)
 *   npm run migrate:dev    (terminal 2)
 *   npm run demo           (terminal 2)
 *
 * Kịch bản kể một câu chuyện: token ≠ quyền biểu quyết → ủy quyền → proposal → bỏ phiếu (có
 * snapshot, có chống bỏ phiếu hai lần) → đổi đại diện → xem lịch sử → ủy quyền bằng chữ ký.
 * Script dùng lại helper của test (ký EIP-712 bằng RPC của Ganache — không có private key nào).
 */

// `truffle exec` chỉ đưa web3/artifacts vào phạm vi của file này; helper của test cần chúng ở global.
global.web3 = web3;
global.artifacts = artifacts;

const GovernanceToken = artifacts.require('GovernanceToken');
const DelegateGovernor = artifacts.require('DelegateGovernor');
const { decodeCustomError, findEvents } = require('../test/helpers/evm');
const { signDelegation } = require('../test/helpers/signatures');

const STATES = ['Pending', 'Active', 'Defeated', 'Succeeded', 'Executed', 'Canceled'];
const VOTES = ['Against', 'For', 'Abstain'];
const ZERO = '0x0000000000000000000000000000000000000000';

const dao = (n) => web3.utils.toWei(String(n), 'ether');
const fmt = (wei) => Number(web3.utils.fromWei(wei.toString())).toLocaleString('en-US') + ' DAOT';

async function mine(blocks) {
  for (let i = 0; i < blocks; i++) {
    await new Promise((resolve, reject) =>
      web3.currentProvider.send({ jsonrpc: '2.0', method: 'evm_mine', params: [], id: i }, (e, r) =>
        e ? reject(e) : resolve(r)
      )
    );
  }
}

module.exports = async function (callback) {
  try {
    const [owner, alice, bob, carol] = await web3.eth.getAccounts();
    const names = { [owner]: 'owner', [alice]: 'Alice', [bob]: 'Bob', [carol]: 'Carol', [ZERO]: '0x0 (không ai)' };
    const who = (a) => names[a] || a;

    const token = await GovernanceToken.deployed();
    const governor = await DelegateGovernor.deployed();

    const step = (title) => console.log(`\n━━━ ${title}`);
    const show = async (label, address) =>
      console.log(
        `  ${label.padEnd(8)} token: ${fmt(await token.balanceOf(address)).padEnd(18)}` +
          `voting power: ${fmt(await token.getVotes(address)).padEnd(18)}` +
          `đại diện: ${who(await token.delegates(address))}`
      );
    const printHistory = async (account) => {
      const history = await token.getDelegationHistory(account);
      console.log(`  Lịch sử delegation của ${who(account)} (${history.length} record):`);
      history.forEach((r, i) =>
        console.log(`    #${i}  ${who(r.previousDelegate).padEnd(15)} → ${who(r.newDelegate).padEnd(15)} (block ${r.blockNumber})`)
      );
    };

    console.log(`Token   : ${token.address}\nGovernor: ${governor.address}`);

    step('1. Token KHÁC quyền biểu quyết');
    // Chỉ bù phần thiếu để chạy lại demo nhiều lần được (muốn trạng thái sạch: npm run migrate:dev).
    for (const [account, target] of [[alice, 300000], [bob, 200000], [carol, 100000]]) {
      const missing = web3.utils.toBN(dao(target)).sub(await token.balanceOf(account));
      if (missing.gtn(0)) await token.transfer(account, missing, { from: owner });
    }
    await show('Alice', alice);
    console.log('  → Alice có token nhưng chưa ủy quyền, nên chưa có quyền biểu quyết (lần chạy đầu: 0).');

    step('2. Kích hoạt quyền biểu quyết');
    await token.delegate(alice, { from: alice }); //  tự ủy quyền
    await token.delegate(bob, { from: bob }); //      tự ủy quyền
    await token.delegate(bob, { from: carol }); //    Carol ủy quyền cho Bob
    await show('Alice', alice);
    await show('Bob', bob);
    await show('Carol', carol);
    console.log('  → Bob giữ phiếu của cả Bob và Carol; Carol giữ token nhưng không còn phiếu.');

    step('3. Bob tạo proposal');
    const created = await governor.createProposal('Dùng 10% ngân quỹ để tài trợ hackathon', { from: bob });
    const { proposalId, snapshotBlock, voteStart } = findEvents(created, 'ProposalCreated')[0].args;
    console.log(`  proposal #${proposalId}  snapshot = block ${snapshotBlock}  mở vote từ block ${voteStart}`);
    console.log(`  quorum cần: ${fmt(await governor.quorumVotes(proposalId))}  trạng thái: ${STATES[await governor.state(proposalId)]}`);

    step('4. Bỏ phiếu');
    await mine(Number(voteStart) - (await web3.eth.getBlockNumber()) - 1);
    for (const [label, voter, support] of [
      ['owner', owner, 1],
      ['Alice', alice, 1],
      ['Bob', bob, 0],
    ]) {
      const receipt = await governor.castVote(proposalId, support, { from: voter });
      const { votes } = findEvents(receipt, 'VoteCast')[0].args;
      console.log(`  ${label.padEnd(6)} bỏ phiếu ${VOTES[support].padEnd(8)} với ${fmt(votes)}`);
    }
    try {
      await governor.castVote(proposalId, 1, { from: alice });
      console.log('  ✗ Alice bỏ phiếu được lần hai — LỖI!');
    } catch (e) {
      console.log(`  Alice thử bỏ phiếu lần hai → revert: ${decodeCustomError(e)}`);
    }
    try {
      await governor.castVote(proposalId, 1, { from: carol });
      console.log('  ✗ Carol bỏ phiếu được — LỖI!');
    } catch (e) {
      console.log(`  Carol (đã ủy quyền cho Bob) thử bỏ phiếu → revert: ${decodeCustomError(e)}`);
    }

    step('5. Đổi đại diện SAU snapshot — kết quả đã chốt không đổi');
    await token.delegate(bob, { from: alice }); // Alice → Bob: phiếu HIỆN TẠI của Bob tăng
    console.log(`  getVotes(Bob) bây giờ          : ${fmt(await token.getVotes(bob))}  ← có thêm phiếu của Alice`);
    console.log(`  getPastVotes(Bob, snapshot)    : ${fmt(await token.getPastVotes(bob, snapshotBlock))}  ← số phiếu đã chốt cho proposal`);
    console.log(`  getVotingPowerForProposal(Bob) : ${fmt(await governor.getVotingPowerForProposal(proposalId, bob))}`);
    await token.delegate(carol, { from: alice }); // Alice → Carol: đổi đại diện lần nữa
    await printHistory(alice);

    step('6. Kết quả');
    await mine(Number((await governor.getProposal(proposalId)).voteEnd) - (await web3.eth.getBlockNumber()) + 2);
    const v = await governor.proposalVotes(proposalId);
    console.log(`  For ${fmt(v.forVotes)} · Against ${fmt(v.againstVotes)} · Abstain ${fmt(v.abstainVotes)}`);
    console.log(`  Trạng thái: ${STATES[await governor.state(proposalId)]}`);
    await governor.execute(proposalId, { from: owner });
    console.log(`  Sau execute(): ${STATES[await governor.state(proposalId)]}  (chỉ ghi nhận, không chạy calldata)`);

    step('7. Ủy quyền bằng chữ ký (delegateBySig) — người khác gửi giúp');
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const nonce = await token.nonces(carol);
    const { v: sv, r, s } = await signDelegation(token, carol, alice, nonce, expiry);
    const ownerRecordsBefore = await token.getDelegationCount(owner);
    await token.delegateBySig(alice, nonce, expiry, sv, r, s, { from: owner }); // owner trả gas
    console.log(`  Carol ký off-chain, owner gửi giao dịch. delegates(Carol) = ${who(await token.delegates(carol))}`);
    await printHistory(carol);
    console.log(
      `  Số record của owner (người gửi tx): ${ownerRecordsBefore} trước → ${await token.getDelegationCount(owner)} sau — không đổi, vì history ghi cho người KÝ.`
    );

    console.log('\nHoàn tất.');
    callback();
  } catch (error) {
    callback(error);
  }
};
