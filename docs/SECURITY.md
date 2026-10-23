# DelegateDAO — Rà soát bảo mật

> **Đây là tự rà soát, không phải rà soát độc lập.** Cùng một phiên AI viết contract, test và bản rà
> soát này. Quy trình của dự án (`.claude/skills/smart-contract-security-review`) yêu cầu người rà soát
> độc lập với người viết; để đạt điều đó, chạy lại bằng agent `security-reviewer` trong một phiên
> mới. Tài liệu này **không** khẳng định contract an toàn.

## 1. Phạm vi và phương pháp

| Mục | Giá trị |
|---|---|
| Contract | `GovernanceToken`, `DelegationHistory` (abstract), `DelegateGovernor` |
| Không thuộc phạm vi | `contracts/mocks/PlainVotesToken.sol` (chỉ để đo gas, không deploy) |
| Phụ thuộc | OpenZeppelin Contracts 5.1.0 (ghim), solc 0.8.24, `evmVersion: paris` |
| Compile | `npm run compile` — không có warning |
| Test | `npm test` — số lượng và kết quả thật ở README |
| Kiểm tra đột biến | Cố ý phá 3 bất biến, xác nhận test đỏ (§3) |
| Quét bí mật | grep `mnemonic`, `private key`, chuỗi hex 64 ký tự trong repo (loại `node_modules`, `build`) |

## 2. Phát hiện

| # | Mức | Phát hiện | Trạng thái |
|---|---|---|---|
| F1 | Medium | `DelegateGovernor._quorum` đọc `quorumNumerator` **hiện tại**. Owner đổi tham số sau khi vote kết thúc có thể lật `Succeeded` ↔ `Defeated`. Ví dụ: For 400 / quorum 20% của 1000 → Succeeded; owner đặt 100% → Defeated. | **Đã sửa:** `quorumPercent` chốt trong `Proposal` lúc tạo. Test: "đổi quorum KHÔNG lật được kết quả proposal đã kết thúc". |
| F2 | Low | `createProposal` ép kiểu `uint48(block.number + votingDelay)` và `uint48(... + votingPeriod - 1)`. Ép kiểu trần **cắt bit thầm lặng**; owner đặt `votingPeriod ≥ 2^48` làm `voteEnd` quay vòng về số nhỏ. Cần owner độc hại hoặc nhập nhầm. | **Đã sửa:** dùng `SafeCast.toUint48` của OZ (revert khi tràn). Test: "votingPeriod/votingDelay quá lớn…". |
| F3 | Low | `.env.example` chứa mnemonic công khai `test test … junk`. Khóa của nó ai cũng biết; bot quét và rút mọi khoản gửi vào trên chain công khai. | **Đã sửa:** thay bằng chuỗi placeholder (deploy sẽ lỗi rõ ràng thay vì dùng khóa đã lộ). |
| F4 | Info | Tài liệu cũ ước lượng gas history ~45k/~25k; đo thật là ~92k (lần đầu, token mới) / ~58k mỗi record. | Đã đo (`test/Gas.test.js`) và sửa ARCHITECTURE §4.5; số cũ trong comment `DelegationHistory.sol` và ARCHITECTURE §4.5 cũng đã đồng bộ. |
| F6 | Info | `DelegationHistory.getLatestDelegation` dùng `require(…, "DelegationHistory: no history")` — chuỗi, trái chuẩn custom error của dự án. Không có tác động bảo mật. | **Đã sửa:** `DelegationHistoryNoRecords(address)`; test đổi sang khẳng định đúng tên lỗi. |
| F7 | Low (vận hành) | `npm test` chạy trên Ganache dev ở :8545 nếu đang mở (Truffle chọn network `development`): test deploy contract và đào block vào node dùng để demo. | **Đã sửa:** `truffle-config.test.js` không có network; xem ARCHITECTURE §1.2. |
| F5 | Info | Comment trỏ tới `Votes._validateTimepoint` (không tồn tại ở OZ 5.1.0) và sai số dòng. | Đã sửa, đối chiếu `node_modules`. |

## 3. Kiểm tra đột biến (mutation check)

Mỗi lần sửa contract **tạm thời**, chạy test, xác nhận có test đỏ, rồi khôi phục. Chạy lại toàn bộ
suite sau khôi phục.

| Đột biến | Test đỏ | Chứng minh |
|---|---|---|
| `_quorum` đọc `quorumNumerator` hiện tại | 1 | F1 được bảo vệ |
| `_delegate` gọi `super._delegate` **trước** `_recordDelegation` | 9 (`DelegationHistory`) | `previousDelegate` luôn đọc trước khi OZ ghi đè |
| `_castVote` dùng `getVotes` thay `getPastVotes` | 4 (`Security`) | snapshot chặn nhân đôi phiếu |

Ý nghĩa: các test này **thật sự** phát hiện lỗi chứ không chỉ chạy qua. Giới hạn: chỉ 3 đột biến thủ
công, không phải công cụ mutation testing đầy đủ.

## 4. Checklist

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| `mint`, `set*` chỉ owner | Đạt | `onlyOwner` ở `GovernanceToken.sol:78`; test `OwnableUnauthorizedAccount` |
| `cancel` chỉ proposer/owner, chỉ khi Pending/Active | Đạt | `DelegateGovernor.sol:358`; test nhóm "Cancel" |
| Không có đường ghi history từ ngoài | Đạt | `_recordDelegation` là `internal` (`DelegationHistory.sol:107`), một chỗ gọi (`GovernanceToken.sol:115`); test khóa danh sách hàm ghi trong ABI |
| Phiếu tính bằng snapshot | Đạt | `DelegateGovernor.sol:314` dùng `getPastVotes`; không có `getVotes` trong luồng vote; đột biến M3 |
| Chống double vote | Đạt | `hasVoted` ở `:317`; test "vote lần hai", "đổi đại diện sau snapshot không nhân đôi" |
| Quorum chốt lúc tạo | Đạt | `:247`, `snapshotTotalSupply`; test mint giữa kỳ |
| `delegateBySig`: nonce, expiry, domain | Đạt | test replay, hết hạn, sai contract, nonce chung với `permit` |
| Bất biến history == `DelegateChanged` | Đạt | test trực tiếp + chuỗi 36 thao tác hỗn hợp (xác định) |
| Bảo toàn phiếu | Đạt | cùng chuỗi 36 thao tác: phiếu mỗi đại diện = tổng balance người ủy quyền |
| Reentrancy | Không áp dụng | Chỉ gọi `IVotes` (view) trên `token` immutable; không gửi ETH, không callback |
| `execute()` không chạy calldata | Đạt (đọc code) | `:341` chỉ đặt cờ và emit |
| DoS do mảng không giới hạn | Giảm nhẹ | Getter phân trang; `getDelegationHistory` chỉ nên gọi qua `eth_call` |
| Bí mật trong repo | Đạt | grep không thấy khóa/mnemonic thật; `.env` được ignore, không tồn tại trong repo |
| Phụ thuộc | Đạt | OZ ghim `5.1.0`; không có dependency lạ trong contract |

## 5. Rủi ro còn lại (chấp nhận có chủ ý, ghi rõ)

1. **Owner tập trung quyền.** Owner có thể: mint tới `MAX_SUPPLY` cho địa chỉ tùy ý (tạo thêm
   quyền biểu quyết cho proposal **sau**; không ảnh hưởng proposal có snapshot đã qua — xem mục 3 về cửa sổ snapshot), hủy **bất kỳ**
   proposal đang Pending/Active (kiểm duyệt), đổi tham số cho proposal tương lai, và
   `renounceOwnership` (khóa vĩnh viễn mint/tham số). Hướng đi đúng: chuyển quyền cho Timelock/chính
   Governor — ngoài phạm vi đồ án.
2. **Không có ngưỡng tạo proposal.** Ai có ≥ 1 wei voting power đều tạo được proposal (chỉ giới hạn
   mô tả 1000 byte). Spam chỉ tốn gas của người spam.
3. **Cửa sổ snapshot.** Snapshot là cuối block `N + votingDelay`; token nhận hoặc `delegate()` trong
   khoảng `votingDelay` sau khi tạo proposal **vẫn được tính**. Đây là mục đích của `votingDelay` (người
   dùng kịp chuẩn bị), nhưng cũng là cửa sổ để vận động mua phiếu. Không có biện pháp kỹ thuật nào khác
   ngoài việc đặt `votingDelay` ngắn.
4. **`execute()` là no-op.** Kết quả proposal chỉ được ghi nhận, không tự thực thi gì.
5. **Chi phí gas của history.** ~58k gas/record (xem ARCHITECTURE §4.5) — đắt cho DAO thương mại.
6. **Thời gian tính theo block.** `block.number` có ngữ nghĩa khác trên một số L2 — chưa đánh giá.
7. **`mint` vượt trần** báo bằng `Panic(0x11)` thay vì custom error khi `amount` gần `2^256` (cộng
   tràn trước khi so với `MAX_SUPPLY`). Vô hại — vẫn revert — nhưng thông báo kém rõ. (Suy ra từ ngữ
   nghĩa Solidity 0.8, chưa có test riêng.)

## 6. Chưa kiểm tra

- Không dùng công cụ phân tích tĩnh (Slither, Mythril, solhint) — **chưa chạy**.
- Không fuzz/invariant testing chuyên dụng (Echidna, Foundry); chuỗi 36 thao tác là xác định, không ngẫu nhiên thật.
- Không formal verification, không audit từ bên ngoài.
- Chưa kiểm tra danh sách advisory của OpenZeppelin cho đúng phiên bản 5.1.0.
- Chưa kiểm tra trên testnet/mainnet; mọi test chạy trên Ganache.
- Chưa kiểm tra hành vi khi một địa chỉ có hàng nghìn record history (giới hạn gas của getter).
- Không kiểm tra giao diện web (không có).

## 7. Kết luận

Trong phạm vi và phương pháp nêu ở §1, không tìm thấy thêm vấn đề ngoài các mục §2 (đã sửa) và §5
(chấp nhận). Điều này **không** đồng nghĩa contract không có lỗi.
