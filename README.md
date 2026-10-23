# DelegateDAO

Đồ án môn Blockchain — **Smart Contracts for DAO with Vote Delegation and Delegation History**.

Người giữ governance token có thể ủy quyền quyền biểu quyết cho một đại diện, tự ủy quyền, đổi đại
diện và tra cứu lịch sử các lần đổi; DAO có proposal, bỏ phiếu theo snapshot, quorum và chống bỏ
phiếu hai lần.

Công nghệ: Solidity 0.8.24 · OpenZeppelin Contracts **5.1.0** · Truffle 5.11.5 · Ganache · JavaScript.

## Kiến trúc

```
DelegateGovernor ──IVotes──▶ GovernanceToken ◀── kế thừa ── DelegationHistory (abstract)
 proposal · vote · quorum     ERC20 + Permit + Votes + Ownable   mảng record + getter phân trang
```

| Contract | Việc | Phần của OpenZeppelin | Phần tự viết |
|---|---|---|---|
| `GovernanceToken` | Token + ủy quyền + checkpoint | `ERC20`, `ERC20Permit`, `ERC20Votes`, `Votes`, `Ownable` | `mint` có trần; override `_delegate` để ghi history |
| `DelegationHistory` | Lịch sử đổi đại diện | — | struct, mảng, event, getter |
| `DelegateGovernor` | Vòng đời proposal | `IVotes`, `SafeCast`, `Ownable` | proposal, đếm phiếu, quorum, state |

Năm khái niệm **không được nhầm**: địa chỉ đang được ủy quyền (`delegates`) · voting power hiện tại
(`getVotes`) · lịch sử quan hệ ủy quyền (`getDelegationHistory`) · lịch sử checkpoint
(`getPastVotes`) · voting power chốt tại proposal. Chi tiết, mô hình dữ liệu, phân tích gas và rủi ro:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

> **Giữ token ≠ có quyền biểu quyết.** Chưa gọi `delegate()` thì `getVotes()` = 0. Muốn tự bỏ phiếu
> phải `delegate(địa_chỉ_của_mình)`.

## Cài đặt và chạy

Cần Node.js ≥ 18 (đã chạy trên Node 24.14, npm 11.9, Windows 11).

```bash
npm install
npm run compile      # biên dịch
npm test             # toàn bộ test, trên Ganache riêng của Truffle (không dùng Ganache ở :8545)
npm run ganache      # blockchain local (terminal riêng)
npm run migrate:dev  # deploy lên Ganache
npm run demo         # kịch bản demo đầu-cuối
```

Kịch bản demo và câu hỏi bảo vệ: [docs/DEMO.md](docs/DEMO.md). Testnet Sepolia: sao chép
`.env.example` → `.env`, điền ví **dùng một lần** và RPC URL, rồi `npx truffle migrate --network sepolia`
(chưa được thử trong dự án này).

## Cấu trúc

```
contracts/    GovernanceToken · DelegationHistory · DelegateGovernor · mocks/PlainVotesToken (chỉ đo gas)
migrations/   1 deploy token (+ self-delegate cho owner) · 2 deploy governor
test/         5 file test + helpers/ (EVM, ký EIP-712 không dùng private key)
scripts/      demo.js
docs/         ARCHITECTURE · DEMO · SECURITY
.claude/      rules/ · skills/ · agents/   (bộ chỉ dẫn cho AI coding agent — Claude Code)
```

## Kết quả kiểm thử

Chạy `npm test` trong phiên làm việc này: **115 test của dự án pass, 0 fail**, compile không warning.

| File | Số test | Trọng tâm |
|---|---:|---|
| `GovernanceToken.test.js` | 27 | ERC-20, token ≠ voting power, checkpoint, mint |
| `DelegationHistory.test.js` | 23 | first/đổi/tự/lại cùng người/hủy, `delegateBySig`, phân trang, history == event |
| `DelegateGovernor.test.js` | 51 | vòng đời, biên block, quorum, Abstain, cancel, tham số owner |
| `Security.test.js` | 13 | snapshot, bề mặt hàm ghi, replay/nonce chữ ký, bảo toàn phiếu |
| `Gas.test.js` | 1 | đo chi phí history |

Đo gas `delegate()` (có / không có history): lần đầu 187,961 / 95,689 · đổi đại diện 169,417 / 111,357 ·
ủy quyền lại cùng người 86,610 / 28,514 — tức ~58k gas mỗi record. Bảng và cách đo ở ARCHITECTURE §4.5.

Đã kiểm tra bằng cách **cố ý phá** 3 bất biến (quorum chốt lúc tạo, thứ tự đọc `previousDelegate`,
snapshot) và xác nhận test đỏ — xem [docs/SECURITY.md](docs/SECURITY.md) §3.

## Giới hạn phạm vi (có chủ ý)

- `execute()` chỉ ghi nhận `Executed`, **không** chạy calldata; thực thi cần Timelock.
- Owner tập trung quyền (mint, hủy proposal, đặt tham số cho proposal sau).
- History on-chain tốn gas (~58k/record); DAO thương mại sẽ dùng event + indexer.
- Chưa có giao diện web; chưa kiểm thử trên testnet; chưa audit độc lập, chưa chạy công cụ phân tích
  tĩnh. Xem [docs/SECURITY.md](docs/SECURITY.md) §5–§6.

## Ghi nhận

- Phần checkpoint, delegation, ECDSA/EIP-712, `Ownable`, `SafeCast` là của
  [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) 5.1.0 (MIT).
- Đồ án có sử dụng AI coding agent (Claude Code) để thiết kế, viết code, test và tài liệu; bộ chỉ dẫn nằm
  ở `.claude/`. Hãy ghi nhận theo quy định của trường/giảng viên.
