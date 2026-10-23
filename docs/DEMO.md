# DelegateDAO — Kịch bản demo

Thời lượng: ~10 phút. Mọi lệnh chạy từ thư mục gốc của repo.

## 1. Chuẩn bị (một lần)

```bash
npm install
```

Terminal 1 — blockchain local (để chạy nguyên, không tắt):

```bash
npm run ganache
```

Terminal 2 — deploy hai contract lên Ganache (`--reset`, luôn cho trạng thái sạch):

```bash
npm run migrate:dev
```

Migration 1 mint 1.000.000 DAOT cho owner **và** gọi `delegate(owner)`; không có bước này owner có
token nhưng `getVotes` = 0 và không tạo được proposal. Migration 2 lấy địa chỉ token từ bước 1.

> Cảnh báo `Cannot find module '../binaries/uws_win32_x64_137.node'` / "µWS" khi chạy trên Node 24 là
> của Ganache đi kèm Truffle, tự chuyển sang bản JS thuần; không ảnh hưởng kết quả.

## 2. Chạy demo

```bash
npm run demo
```

Có thể chạy lại nhiều lần để tập; muốn kể lại từ trạng thái sạch (bước 1 hiện voting power = 0) thì
chạy `npm run migrate:dev` trước. Địa chỉ và số block khác nhau mỗi lần deploy.

Output của một lần chạy thật trên Ganache sạch (rút gọn phần đầu):

```
━━━ 1. Token KHÁC quyền biểu quyết
  Alice    token: 300,000 DAOT      voting power: 0 DAOT            đại diện: 0x0 (không ai)
━━━ 2. Kích hoạt quyền biểu quyết
  Alice    token: 300,000 DAOT      voting power: 300,000 DAOT      đại diện: Alice
  Bob      token: 200,000 DAOT      voting power: 300,000 DAOT      đại diện: Bob
  Carol    token: 100,000 DAOT      voting power: 0 DAOT            đại diện: Bob
━━━ 3. Bob tạo proposal
  proposal #1  snapshot = block 3366  mở vote từ block 3367
  quorum cần: 40,000 DAOT  trạng thái: Pending
━━━ 4. Bỏ phiếu
  owner  bỏ phiếu For      với 400,000 DAOT
  Alice  bỏ phiếu For      với 300,000 DAOT
  Bob    bỏ phiếu Against  với 300,000 DAOT
  Alice thử bỏ phiếu lần hai → revert: GovernorAlreadyVoted
  Carol (đã ủy quyền cho Bob) thử bỏ phiếu → revert: GovernorNoVotingPower
━━━ 5. Đổi đại diện SAU snapshot — kết quả đã chốt không đổi
  getVotes(Bob) bây giờ          : 600,000 DAOT  ← có thêm phiếu của Alice
  getPastVotes(Bob, snapshot)    : 300,000 DAOT  ← số phiếu đã chốt cho proposal
  getVotingPowerForProposal(Bob) : 300,000 DAOT
  Lịch sử delegation của Alice (3 record):
    #0  0x0 (không ai)  → Alice           (block 3362)
    #1  Alice           → Bob             (block 3370)
    #2  Bob             → Carol           (block 3371)
━━━ 6. Kết quả
  For 700,000 DAOT · Against 300,000 DAOT · Abstain 0 DAOT
  Trạng thái: Succeeded
  Sau execute(): Executed  (chỉ ghi nhận, không chạy calldata)
━━━ 7. Ủy quyền bằng chữ ký (delegateBySig) — người khác gửi giúp
  Carol ký off-chain, owner gửi giao dịch. delegates(Carol) = Alice
  Lịch sử delegation của Carol (2 record):
    #0  0x0 (không ai)  → Bob             (block 3364)
    #1  Bob             → Alice           (block 3420)
  Số record của owner (người gửi tx): 1 trước → 1 sau — không đổi, vì history ghi cho người KÝ.
```

## 3. Điều cần nói ở từng bước

| Bước | Thông điệp | Khái niệm (ARCHITECTURE §3) |
|---|---|---|
| 1 | Có token ≠ có quyền biểu quyết | `getVotes` = 0 cho đến khi `delegate()` |
| 2 | Bob giữ 300k = 200k của mình + 100k của Carol; Carol còn token, hết phiếu | `delegates()` vs `getVotes()` |
| 3 | Proposal chốt `snapshotBlock` và tổng cung ngay lúc tạo | snapshot |
| 4 | Chống double vote; người đã ủy quyền không tự vote | `hasVoted`, `GovernorNoVotingPower` |
| 5 | Phiếu hiện tại (600k) khác phiếu đã chốt (300k); lịch sử quan hệ là thứ thứ ba | `getVotes` ≠ `getPastVotes` ≠ `getDelegationHistory` |
| 6 | Kết quả = For > Against **và** đủ quorum | quorum, `state()` |
| 7 | Người khác trả gas vẫn ghi đúng người ký | `delegateBySig` đi qua `_delegate` |

## 4. Tự thao tác trong console (tùy chọn)

> Phần này **chưa được kiểm thử tự động** (console của Truffle cần terminal tương tác). Gõ thử trước
> buổi demo. Cùng các lệnh gọi đó đã chạy trong `scripts/demo.js`.

```bash
npm run console
```

```js
const t = await GovernanceToken.deployed()
const accounts = await web3.eth.getAccounts()
await t.delegate(accounts[2], { from: accounts[1] })
await t.getDelegationHistory(accounts[1])
```

## 5. Câu hỏi thường gặp khi bảo vệ

**Event `DelegateChanged` của OZ đã có, sao cần mảng history?**
Solidity không đọc được log của chính mình. Mảng cho phép truy vấn on-chain bằng `eth_call`
(`DelegationHistory.sol`). Cả hai cùng sinh từ một điểm ghi duy nhất — `GovernanceToken._delegate`
(`GovernanceToken.sol:114`) — nên không lệch; bất biến này có test (`DelegationHistory.test.js`,
`Security.test.js`).

**Sao override `_delegate` mà không override `delegate`?**
`delegate()` và `delegateBySig()` đều gọi `_delegate()` (OZ 5.1.0 `Votes.sol:136`, `:160`). Override
một hàm bắt cả hai; override `delegate` thì chữ ký lọt khỏi history. Test: "ghi record cho NGƯỜI KÝ".

**Sao đọc `delegates(account)` trước `super._delegate`?**
`super` ghi đè giá trị đó; đảo thứ tự thì `previousDelegate` luôn bằng `newDelegate`. Đã thử đảo thật:
9 test đỏ (SECURITY.md §3).

**Lịch sử delegation khác checkpoint ở đâu?**
History là *quan hệ* "A ủy quyền cho B" (ai→ai, theo thời gian). Checkpoint là *số lượng* "B giữ bao
nhiêu phiếu tại block X". Đổi đại diện: 1 record + 2 checkpoint. Chuyển token: 0 record, vài checkpoint.

**Sao vote dùng `getPastVotes`, không dùng `getVotes`?**
Nếu dùng phiếu hiện tại: vote → chuyển token sang ví khác → ví đó vote lại, nhân đôi quyền lực.
(`DelegateGovernor.sol:314`; test "vote rồi chuyển token sang ví mới", đã thử đảo thật: 4 test đỏ.)

**Sao `votingDelay` phải ≥ 1?**
`getPastVotes` của OZ 5.x revert `ERC5805FutureLookup` nếu mốc chưa qua. Delay = 0 thì snapshot chính là
block hiện tại và mọi lệnh vote cùng block đều revert.

**Sao không dùng `Governor` của OZ?**
Quá lớn để giải thích; đề bài tập trung vào delegation history. Governor ở đây 508 dòng (khoảng 270 dòng code, còn lại là comment) nhưng vẫn
dùng `IVotes`, checkpoint, `SafeCast`, `Ownable` của OZ (ARCHITECTURE §5.1).

**`execute()` làm gì?**
Chỉ đánh dấu `Executed` và emit event. Thực thi calldata tùy ý cần Timelock — ngoài phạm vi, ghi rõ.

**Chi phí gas của history?**
~58k gas mỗi record, đo thật bằng `Gas.test.js` (ARCHITECTURE §4.5). DAO thương mại chỉ emit event và
dùng indexer; đồ án chọn on-chain để truy vấn được và dễ demo.

**Có an toàn không?**
Không dám nói vậy. Xem `SECURITY.md`: những gì đã kiểm tra, đã sửa, đã chấp nhận, và đặc biệt mục
"Chưa kiểm tra".
