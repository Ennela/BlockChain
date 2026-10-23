# DelegateDAO — Kiến trúc hệ thống

> Đồ án môn Blockchain: *Smart Contracts for DAO with Vote Delegation and Delegation History*.
> Tài liệu này ghi lại kiến trúc, mô hình dữ liệu, các quyết định thiết kế và lý do đằng sau chúng.

## 1. Môi trường đã khảo sát

Repository ban đầu **rỗng** (không có file, không có git history). Không có code nào để tái sử dụng,
nên toàn bộ scaffolding được tạo mới. Các phiên bản dưới đây được kiểm tra trực tiếp trên máy:

| Thành phần | Phiên bản | Ghi chú |
|---|---|---|
| Node.js | v24.14.0 | Đã cài sẵn |
| npm | 11.9.0 | Đã cài sẵn |
| Truffle | 5.11.5 | Bản mới nhất trên npm; cài local vào devDependencies |
| Ganache | 7.9.2 | Cài local; chạy qua `npm run ganache` |
| `@openzeppelin/contracts` | **5.1.0** (ghim chính xác) | Bản mới nhất của 5.x **không dùng opcode `mcopy`** — xem §1.1 |
| solc | 0.8.24 | Do Truffle tải về; OZ 5.x yêu cầu `^0.8.20` |

### Quyết định về phiên bản

- **OpenZeppelin dòng 5.x, không phải 4.x.** 5.x là dòng được hỗ trợ hiện tại. Hệ quả cần nhớ:
  `ERC20Votes` nằm trên nền `Votes` dùng `Checkpoints.Trace208`, `clock()` mặc định là `block.number`,
  và `Ownable` **bắt buộc** truyền `initialOwner` vào constructor. Mọi API trong code đều đối chiếu
  với `node_modules/@openzeppelin/contracts` thực tế, không dựa trên ký ức về 4.x.
- **`evmVersion: "paris"`.** Từ Shanghai trở đi solc phát sinh opcode `PUSH0`, một số build EVM local
  cũ không nhận. Chọn `paris` để demo chạy được ở mọi nơi, đổi lại gas cao hơn không đáng kể.

### 1.1 Vì sao ghim OZ 5.1.0 chứ không lấy bản mới nhất

Bản mới nhất lúc khảo sát là **5.6.1**, và đó là lựa chọn ban đầu. Compile thất bại:

```
DeclarationError: Function "mcopy" not found.
  --> @openzeppelin/contracts/utils/Bytes.sol:94:13
```

`mcopy` là opcode của hard fork **Cancun**. Từ OZ **5.2.0** trở đi, `utils/Bytes.sol` và
`utils/Arrays.sol` dùng nó, nên các bản này **không compile được** với `evmVersion` thấp hơn cancun.

Hướng xử lý đã cân nhắc:

1. **Đổi `evmVersion` sang `cancun`.** Compile được, nhưng kiểm tra `node_modules` cho thấy **Ganache
   7.9.2 chỉ hỗ trợ tối đa `shanghai`** (và Ganache mà `truffle test` dùng nội bộ cũng vậy). Bytecode
   cancun có thể revert khi chạy local. Đổi lỗi compile thành lỗi runtime lúc demo — tệ hơn.
2. **Hạ `@openzeppelin/contracts` xuống bản không dùng `mcopy`.** Đã kiểm tra bằng cách tải tarball
   từng bản: 5.0.2 và 5.1.0 không có `mcopy`; 5.2.0 trở lên thì có. Chọn **5.1.0** — bản mới nhất
   còn tương thích.

Đã xác minh lại toàn bộ API trên 5.1.0 sau khi hạ (không giả định nó giống 5.6.1): `_delegate` vẫn
`internal virtual` ở dòng 168, `delegate` gọi `_delegate` ở dòng 136, `delegateBySig` gọi `_delegate(signer, ...)` ở dòng 160,
`Ownable(address initialOwner)`, `ERC20Permit(string name)`, và `getPastVotes`/`getPastTotalSupply`
vẫn revert `ERC5805FutureLookup` khi `timepoint >= clock()` (Votes.sol:91, :111). Thiết kế không phải
sửa gì. (Số dòng áp dụng cho 5.1.0; kiểm tra lại nếu đổi phiên bản.)

Phiên bản được ghim **chính xác** (`"5.1.0"`, không có `^`): với `^5.1.0`, một lần `npm install` trên
máy khác sẽ kéo về 5.6.x và dự án hỏng ngay. Đây là lý do cụ thể, không phải thói quen.
- **Không dùng `@openzeppelin/test-helpers`.** Package này kéo theo `web3` cũ và hay xung đột trên
  Node mới. Test dùng helper tự viết trong `test/helpers/` — ít dependency, dễ giải thích hơn.

### 1.2 Cô lập `npm test` khỏi Ganache đang chạy

Phát hiện khi rà soát: `truffle-config.js` có network `development` (Ganache tự chạy ở :8545), và khi
không truyền `--network`, `truffle test` **tự chọn `development` nếu có** (Truffle 5.11.5,
`node_modules/truffle/build/6394.bundled.js:160-163`). Tức `npm test` từng chạy trên Ganache dev đang
mở — deploy contract mới và đào hàng nghìn block (`advanceBlocks`) vào node dùng để demo — chứ không phải
Ganache riêng như bản tài liệu cũ nói.

Quyết định: `npm test` = `truffle test --config truffle-config.test.js`. File này nạp lại
`truffle-config.js` (giữ nguyên compiler và mocha) và đặt `networks: {}`. Không có network nào thì Truffle
dựng Ganache tạm trên cổng ngẫu nhiên. `migrate:dev`, `demo`, `console` vẫn dùng `truffle-config.js` và
`--network development` như cũ.

Đã xác minh bằng chạy thật: (1) đối chứng âm — ở bản sao tạm có `development` trỏ vào cổng không ai lắng
nghe (59999), `truffle test` trần báo `CONNECTION ERROR` tới cổng đó; (2) cùng bản sao, `npm test` mới vẫn
chạy xong 23 test của `DelegationHistory.test.js`; (3) trên repo thật, block number, hash và stateRoot của
Ganache :8545 giống hệt trước và sau khi chạy cả bộ test, và `accounts[0]` trong test khác `accounts[0]`
của Ganache dev.

Phương án đã loại: (a) `networks.test = {}` + `--network test` — khi có `--network`, Truffle gọi
`Environment.detect` → `Provider.testConnection` trước khi dựng Ganache tạm; theo đọc mã nó sẽ nối tới
host/port mặc định (loại theo đọc mã, chưa chạy thử vì có thể chạm :8545). (b) Đổi tên hoặc xóa
`development` — làm vỡ `migrate:dev`, `demo`, `console`. (c) Tự khởi tạo `ganache.provider()` trong
config — phải tự duy trì hardfork/gas limit trong khi Ganache do Truffle quản lý đã chạy ổn bộ test.

## 2. Tổng quan kiến trúc

Ba lớp, hai contract deploy được:

```
┌──────────────────────────────────────────────────────────────┐
│  DelegateGovernor                      (deploy #2)           │
│  Proposal · voting window · quorum · chống double-vote       │
│  Đọc voting power qua IVotes.getPastVotes(voter, snapshot)    │
└───────────────────────────┬──────────────────────────────────┘
                            │ IVotes (interface của OZ)
┌───────────────────────────▼──────────────────────────────────┐
│  GovernanceToken                       (deploy #1)           │
│  ERC20 · ERC20Permit · ERC20Votes · Ownable                   │
│  Checkpoint voting power — toàn bộ do OZ đảm nhiệm            │
└───────────────────────────┬──────────────────────────────────┘
                            │ kế thừa, override _delegate()
┌───────────────────────────▼──────────────────────────────────┐
│  DelegationHistory (abstract)                                │
│  Mảng DelegationRecord mỗi delegator · getter phân trang      │
└──────────────────────────────────────────────────────────────┘
```

`DelegationHistory` là **abstract contract được kế thừa**, không phải contract riêng. Lý do ở §4.3.

## 3. Năm khái niệm phải phân biệt rõ

Đây là phần sinh viên hay nhầm nhất, và cũng là phần giảng viên hay hỏi. Mỗi khái niệm có đúng
một nguồn dữ liệu:

| # | Khái niệm | Truy vấn bằng | Lưu ở đâu |
|---|---|---|---|
| 1 | **Địa chỉ đang được ủy quyền** — hiện tại tôi ủy quyền cho ai | `delegates(account)` | `Votes._delegatee` |
| 2 | **Voting power tổng hợp** — đại diện đang giữ bao nhiêu phiếu *ngay lúc này* | `getVotes(account)` | checkpoint mới nhất |
| 3 | **Lịch sử quan hệ ủy quyền** — tôi đã từng đổi đại diện mấy lần, khi nào, từ ai sang ai | `getDelegationHistory(account)` | `DelegationHistory._history` |
| 4 | **Lịch sử checkpoint của voting power** — tại block X, đại diện đó giữ bao nhiêu phiếu | `getPastVotes(account, blockNumber)` | `Checkpoints.Trace208` |
| 5 | **Voting power snapshot tại proposal** — số phiếu dùng để tính kết quả | `getPastVotes(voter, proposal.snapshotBlock)` | suy ra từ (4) |

Ba điểm dễ sai:

- **(2) khác (4).** `getVotes` trả về giá trị *hiện tại* và thay đổi liên tục. Voting dùng (4), chốt
  tại một block cố định trong quá khứ. Nếu dùng (2) để tính phiếu, người ta có thể vote → chuyển
  token sang ví khác → vote lại và nhân đôi quyền lực.
- **(3) khác (4).** (3) là *lịch sử quan hệ* "A ủy quyền cho B". (4) là *lịch sử số lượng* "B giữ 500
  phiếu". Đổi đại diện tạo một entry ở (3) và hai checkpoint ở (4) (trừ của đại diện cũ, cộng cho
  đại diện mới). Chuyển token thì ngược lại: tạo checkpoint ở (4) nhưng **không** tạo entry ở (3).
- **Token ≠ voting power.** Giữ token mà chưa `delegate()` thì `getVotes` trả về 0. Đây là hành vi cố
  ý của OZ: quyền biểu quyết chỉ tồn tại sau khi được kích hoạt tường minh. Người muốn tự vote phải
  gọi `delegate(chính mình)`. Script demo và README đều nhấn mạnh điểm này.

## 4. Mô hình dữ liệu cho delegation history

### 4.1 OZ đã cho sẵn những gì

Đọc trực tiếp `node_modules/@openzeppelin/contracts/governance/utils/Votes.sol`:

- `delegates(address) → address` — đại diện hiện tại.
- `delegate(address)` và `delegateBySig(...)` — hai entry point đổi delegation, **cả hai đều gọi
  nội bộ `_delegate()`**.
- `_delegate(address account, address delegatee) internal virtual` — điểm giao duy nhất.
- `event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate)`.
- `getVotes`, `getPastVotes`, `getPastTotalSupply` — checkpoint đầy đủ.

Thiếu đúng một thứ: **không thể liệt kê lịch sử delegation từ trong contract.** Event tồn tại,
nhưng Solidity không đọc được log của chính mình — chỉ client off-chain lọc được. Đề bài yêu cầu
"cơ chế ghi nhận **và truy vấn**" lịch sử, nên cần lưu on-chain.

### 4.2 Struct và cách đóng gói slot

```solidity
struct DelegationRecord {
    address previousDelegate; // 20 bytes ┐
    uint48  blockNumber;      //  6 bytes ├─ slot 1 (20+6+6 = 32 bytes, vừa khít)
    uint48  timestamp;        //  6 bytes ┘
    address newDelegate;      // 20 bytes ── slot 2
}
```

`uint48` đủ dùng: `block.timestamp` tràn uint48 vào khoảng năm 8.9 triệu. Đóng gói như trên tốn
**2 slot** thay vì 4 nếu khai báo cả bốn field là 32 byte. Mỗi slot mới ghi vào storage trống tốn
~22.1k gas (SSTORE), nên đóng gói tránh khoảng 2 × 22.1k ≈ 44k gas mỗi record. (Số này suy ra từ bảng
giá EVM, không đo riêng.)

Lưu `previousDelegate` dù về lý thuyết có thể suy ra từ entry trước đó: nó nằm chung slot 1 với
`blockNumber` và `timestamp` — những thứ phải ghi dù sao — nên gần như không tốn thêm SSTORE. Đổi lại
mỗi record tự đủ nghĩa, client không phải đọc hai entry mới hiểu được một thay đổi.

### 4.3 Vì sao là abstract contract kế thừa, không phải contract riêng

Nếu `DelegationHistory` là contract độc lập, `GovernanceToken` phải gọi external sang nó mỗi lần
delegate. Khi đó: (a) ai cũng gọi được hàm ghi nếu nó `public`, tạo ra history giả; (b) nếu một
trong hai lệnh lỗi, hai nguồn dữ liệu lệch nhau vĩnh viễn; (c) tốn thêm gas cho external call.

Giải pháp: abstract contract, hàm ghi là `internal`, `GovernanceToken` kế thừa. Component vẫn tách
riêng về mặt khái niệm và file, nhưng chạy trong **cùng một transaction, cùng một contract**.

### 4.4 Một nguồn ghi duy nhất — bất biến cốt lõi

Yêu cầu "không tạo hai nguồn dữ liệu lịch sử có thể không đồng bộ" được bảo đảm bằng cách
override đúng **một** hàm:

```solidity
function _delegate(address account, address delegatee) internal override {
    _recordDelegation(account, delegates(account), delegatee); // đọc delegate cũ TRƯỚC
    super._delegate(account, delegatee);                       // rồi để OZ xử lý
}
```

Vì cả `delegate()` và `delegateBySig()` đều đi qua `_delegate()`, mọi đường thay đổi delegation đều
bị ghi nhận — kể cả delegation bằng chữ ký mà người gửi transaction không phải chủ token. Không có
đường nào lọt. Mảng history và chuỗi event `DelegateChanged` **luôn có cùng số phần tử theo cùng thứ
tự**: đây là bất biến được kiểm tra bằng test riêng.

Hệ quả có chủ ý: ủy quyền lại cho **đúng người đang là đại diện** vẫn tạo một record. OZ vẫn emit
`DelegateChanged` trong trường hợp này, nên nếu ta bỏ qua thì mảng và log sẽ lệch nhau. Ưu tiên giữ
bất biến hơn là tiết kiệm một entry.

### 4.5 Phân tích gas: event, on-chain, hay cả hai

| Phương án | Gas thêm / lần delegate | Truy vấn on-chain | Truy vấn off-chain |
|---|---|---|---|
| Chỉ event | ~0 (OZ đã emit) | ✗ không thể | ✓ rẻ, cần indexer |
| Chỉ mảng on-chain | ~58k mỗi record (đo được, xem dưới) | ✓ | ✓ qua `eth_call` |
| **Cả hai, một nguồn ghi** | như trên | ✓ | ✓ |

**Số đo thật** (`test/Gas.test.js`, so `GovernanceToken` với `PlainVotesToken` — cùng OZ 5.1.0, chỉ
khác không có history; solc 0.8.24, optimizer 200 runs, token mới deploy):

| `delegate()` | có history | không history | chênh lệch |
|---|---:|---:|---:|
| lần đầu (0x0 → bob) | 187,961 | 95,689 | **92,272** |
| đổi đại diện (bob → carol) | 169,417 | 111,357 | **58,060** |
| ủy quyền lại cùng người | 86,610 | 28,514 | **58,096** |

Chênh lệch ~58k/record chủ yếu là **hai slot mới** của `DelegationRecord` (~44k) cộng cập nhật độ dài
mảng, bộ đếm toàn cục và event. Dòng "lần đầu" cao hơn ~34k vì token mới deploy: bộ đếm
`_totalDelegationChanges` và độ dài mảng ghi vào slot trống lần đầu tiên (chỉ người delegate đầu tiên
của cả hệ thống trả khoản này cho bộ đếm). Bộ đếm toàn cục là phần không có trong yêu cầu đề bài; bỏ nó
tiết kiệm khoảng 5k gas/lần theo giá SSTORE (suy ra, chưa đo).

Điều kiện đo: `test/Gas.test.js`, `receipt.gasUsed` của ba lệnh `delegate()` liên tiếp từ cùng một
tài khoản (100 DAOT) trên Ganache do `truffle test` dựng (Truffle 5.11.5, Ganache 7.9.2, Node 24.14),
`evmVersion: paris`. Chỉ **hiệu số** mỗi dòng là số đo; phần phân rã (slot, bộ đếm, event) ở trên là suy
luận từ bảng giá EVM. Chạy lại `npm test` cho cùng ba hiệu số: 92,272 / 58,060 / 58,096.

Chọn **cả hai**, vì event là thứ OZ đã emit sẵn — không bỏ được mà cũng không nên bỏ, hạ tầng
Ethereum (The Graph, Tally, Etherscan) đều dựa vào nó. Rủi ro "hai nguồn" không nằm ở việc có hai
chỗ đọc, mà ở việc có hai chỗ **ghi**; §4.4 khử rủi ro đó.

Cần nói thẳng về chi phí: thêm ~58k gas mỗi lần đổi đại diện (số đo ở bảng trên) là **đắt** cho một DAO thương mại. Một DAO
thật sẽ chỉ emit event rồi index bằng subgraph. Đồ án này chọn on-chain vì đề bài yêu cầu truy vấn
được lịch sử từ contract, và vì mảng on-chain dễ demo trước giảng viên hơn là dựng indexer. Trade-off
này được ghi lại thay vì che đi.

Một điểm phải lưu ý: mảng lịch sử **tăng vô hạn**. `getDelegationHistory()` trả toàn bộ mảng có thể
vượt gas limit nếu một địa chỉ đổi đại diện hàng nghìn lần. Vì vậy có thêm
`getDelegationHistoryPaginated(account, offset, limit)` và `getDelegationCount(account)`.

## 5. DelegateGovernor

### 5.1 Vì sao không dùng `Governor` của OpenZeppelin

OZ có `Governor` + `GovernorSettings` + `GovernorCountingSimple` + `GovernorVotes` +
`GovernorVotesQuorumFraction` + `GovernorTimelockControl`. Đó là bộ công cụ sản xuất: hỗ trợ
execution bằng calldata tùy ý, timelock, clock mode theo timestamp, proposal threshold, relay…
Tổng cộng vài nghìn dòng mà sinh viên không giải thích được trong buổi bảo vệ.

Đề bài trọng tâm là **delegation history**, và tiêu chí chất lượng ghi rõ *"code phải giải thích
được với sinh viên"* và *"không over-engineer"*. Nên `DelegateGovernor` được viết tay, gọn (508 dòng
kể cả comment và dòng trống, khoảng 270 dòng là code), nhưng **vẫn tái sử dụng OZ ở mọi chỗ an toàn-quan trọng**:

- Interface `IVotes` của OZ — không tự định nghĩa lại.
- Toàn bộ logic snapshot do `ERC20Votes`/`Checkpoints` của OZ đảm nhiệm. Governor chỉ *đọc*.
- `Ownable` của OZ cho quyền quản trị tham số.

Nói cách khác: phần mật mã học và cấu trúc dữ liệu khó (checkpoint binary search, ECDSA cho
`delegateBySig`, ERC-2612 permit) đều để OZ làm. Phần tự viết chỉ là vòng đời proposal — thứ cần
đọc hiểu được.

### 5.2 Vòng đời proposal

```
     create()           +votingDelay        +votingPeriod
        │                     │                   │
        ▼                     ▼                   ▼
   ┌─────────┐          ┌──────────┐      ┌───────────────┐
   │ Pending │─────────▶│  Active  │─────▶│ Succeeded /   │
   └────┬────┘          └────┬─────┘      │ Defeated      │
        │                    │            └───────┬───────┘
        │   cancel()         │  cancel()          │ execute()
        ▼                    ▼                    ▼
   ┌──────────┐        ┌──────────┐         ┌──────────┐
   │ Canceled │        │ Canceled │         │ Executed │
   └──────────┘        └──────────┘         └──────────┘
```

`state()` được tính **thuần từ block hiện tại và số phiếu**, không có hàm nào "chuyển trạng thái".
Nhờ vậy không tồn tại trạng thái mồ côi do thiếu một lệnh gọi — trạng thái luôn tự đúng.

### 5.3 Snapshot và chống double voting

```solidity
struct Proposal {
    address proposer;
    uint48  snapshotBlock;  // chốt quyền biểu quyết tại đây
    uint48  voteStart;      // = snapshotBlock + 1
    uint48  voteEnd;
    bool    executed;
    bool    canceled;
    uint256 forVotes;
    uint256 againstVotes;
    uint256 abstainVotes;
    uint8   quorumPercent;       // quorumNumerator chốt lúc tạo (chung slot 2 với voteEnd/cờ)
    uint256 snapshotTotalSupply; // chốt quorum tại cùng block
    string  description;
}
mapping(uint256 => mapping(address => Receipt)) private _receipts;
```

Ba cơ chế bảo vệ, mỗi cơ chế có test riêng:

1. **Snapshot.** `snapshotBlock = block.number + votingDelay` khi tạo proposal; phiếu đọc bằng
   `getPastVotes(voter, snapshotBlock)`. Mua token sau thời điểm đó thì không có quyền vote trên
   proposal đó. `votingDelay >= 1` là bắt buộc để `snapshotBlock < block.number` lúc vote —
   `getPastVotes` của OZ 5.x **revert** nếu timepoint chưa qua.
2. **Chống double voting.** `_receipts[id][voter].hasVoted` chặn lượt thứ hai. Lưu ý đúng ngữ nghĩa:
   chặn theo **người bỏ phiếu**, không theo người ủy quyền. Nếu A ủy quyền cho B, chỉ B vote được,
   và B vote một lần với tổng phiếu của cả hai.
3. **Quorum.** `quorumVotes = snapshotTotalSupply * quorumPercent / 100`. Cả hai vế đều **chốt lúc
   tạo proposal**: tổng cung (nếu lấy hiện tại, mint giữa kỳ vote làm quorum "chạy") và
   `quorumPercent` (nếu đọc `quorumNumerator` hiện tại, owner đổi tham số sau khi vote kết thúc có thể
   lật `Succeeded` ↔ `Defeated`). Lỗi thứ hai có ở bản đầu và được phát hiện khi rà soát; test
   "đổi quorum KHÔNG lật được kết quả proposal đã kết thúc" bảo vệ nó.

Điều kiện thắng: `forVotes > againstVotes` **và** `forVotes + abstainVotes >= quorumVotes`.
Abstain tính vào quorum nhưng không tính vào thắng/thua — theo đúng quy ước
`GovernorCountingSimple` của OZ.

### 5.4 Phạm vi `execute()` — giới hạn có chủ ý

`execute()` chỉ đánh dấu `executed = true` và emit event. **Không** thực thi calldata tùy ý.

Lý do: một governor thực thi được calldata bất kỳ là một contract có toàn quyền trên mọi tài sản nó
quản lý. Làm đúng việc đó cần Timelock (để cộng đồng kịp phản ứng với proposal độc hại), kiểm soát
re-entrancy, và quản lý quyền cẩn thận — vượt xa phạm vi đề bài. Đây là *giới hạn phạm vi được ghi
rõ*, không phải lỗ hổng bị bỏ sót. Hướng mở rộng đúng là `GovernorTimelockControl`, nêu trong README.

### 5.5 Điều kiện tạo proposal và hai mốc chốt dữ liệu

**Người tạo phải có voting power.** `createProposal` revert `GovernorNoVotingPowerToPropose` nếu
`getPastVotes(msg.sender, block.number - 1) == 0` (`DelegateGovernor.sol:227-229`). Đây là ngưỡng tối
thiểu "> 0", không phải ngưỡng theo tỷ lệ token. Hệ quả: người giữ token mà chưa `delegate()`, hoặc đã
ủy quyền hết cho người khác, không tạo được proposal. Test: ba test "người không có token…", "…CHƯA
delegate…", "…đã ủy quyền hết phiếu…" trong nhóm "Tạo proposal" của `DelegateGovernor.test.js`.

**Hai mốc khác nhau trong cùng một proposal** (`N` = block tạo proposal):

| Dữ liệu | Đọc tại | Lý do |
|---|---|---|
| Voting power của từng người | `getPastVotes(voter, snapshotBlock)`, `snapshotBlock = N + votingDelay` (`:237`, `:314`) | Bỏ phiếu chỉ diễn ra sau `snapshotBlock`, nên mốc này đã qua lúc đọc |
| Tổng cung cho quorum (`snapshotTotalSupply`) | `getPastTotalSupply(N - 1)` ngay lúc tạo (`:251`) | `snapshotBlock` còn ở tương lai nên `getPastTotalSupply(snapshotBlock)` sẽ revert `ERC5805FutureLookup` (`Votes.sol:111`); chốt ở block liền trước |

Hệ quả: `mint` (đường duy nhất làm đổi tổng cung sau khi deploy — ABI không có hàm burn) hoặc `delegate()` xảy ra trong
các block từ `N` tới `snapshotBlock` làm đổi voting power được tính nhưng **không** đổi mẫu số quorum.
Ngưỡng quorum bất biến suốt kỳ vote, đó là điều cần chốt. `Security.test.js:95` kiểm tra mint **sau**
snapshot không đổi quorum và không cấp quyền vote; trường hợp mint nằm giữa lúc tạo proposal và
`snapshotBlock` **chưa có test riêng** (rủi ro ghi ở `docs/SECURITY.md` §5.3).

### 5.6 Bảng quyền hạn

Danh sách hàm ghi bị khóa bởi test ABI (`Security.test.js:116`, `:131`): thêm hàm ghi mới thì test đỏ.
Hàm `view`/`pure` (getter, `state()`, `getVotes`, `getPastVotes`…) ai cũng gọi được.

| Contract | Hàm | Ai gọi được | Điều kiện / nguồn |
|---|---|---|---|
| `GovernanceToken` | `mint` | owner | `onlyOwner`, `GovernanceToken.sol:78`; tổng cung ≤ `MAX_SUPPLY` |
| | `transfer`, `approve`, `transferFrom` | bất kỳ | ERC20 của OZ |
| | `permit` | bất kỳ gửi tx | cần chữ ký hợp lệ của chủ token (OZ `ERC20Permit`) |
| | `delegate` | bất kỳ, chỉ cho chính mình | delegator = `msg.sender` (`Votes.sol:134-136`) |
| | `delegateBySig` | bất kỳ gửi tx | delegator = **người ký**; kiểm `nonce`, `expiry` (`Votes.sol:142-160`) |
| | `transferOwnership`, `renounceOwnership` | owner | OZ `Ownable` (`Ownable.sol:76`, `:84`) |
| | `_recordDelegation` | không ai ngoài contract | `internal`; một chỗ gọi `GovernanceToken._delegate` (`:115`) |
| `DelegateGovernor` | `createProposal` | người có voting power > 0 tại `N - 1` | `:227` |
| | `castVote`, `castVoteWithReason` | người có voting power > 0 tại `snapshotBlock` | proposal `Active`, một lần mỗi người (`:303-315`) |
| | `execute` | bất kỳ | proposal `Succeeded`; chỉ đặt cờ và emit (`:341`) |
| | `cancel` | proposer hoặc owner | proposal `Pending`/`Active` (`:358`) |
| | `setVotingDelay`, `setVotingPeriod`, `setQuorumNumerator` | owner | chỉ áp dụng cho proposal tạo sau (`:479-497`) |
| | `transferOwnership`, `renounceOwnership` | owner | OZ `Ownable` |

## 6. Danh sách file tạo/sửa

**Hạ tầng** — `package.json`, `truffle-config.js`, `truffle-config.test.js` (config riêng cho `npm test`, xem §1.2), `.gitignore`, `.env.example`

**Contracts** (`contracts/`)
- `DelegationHistory.sol` — abstract: struct, mảng, event, getter phân trang
- `GovernanceToken.sol` — ERC20 + Permit + Votes + Ownable, override `_delegate`
- `DelegateGovernor.sol` — proposal, voting, quorum, snapshot
- `mocks/PlainVotesToken.sol` — token không có history, **chỉ để đo gas** (không deploy)

**Migrations** (`migrations/`)
- `1_deploy_governance_token.js`
- `2_deploy_delegate_governor.js` — nhận địa chỉ token từ bước 1

Truffle 5.11 không còn cần `Migrations.sol`, nên không tạo file đó.

**Tests** (`test/`)
- `helpers/evm.js` — mine block, lấy block number, bắt revert (tự viết, không cần test-helpers)
- `GovernanceToken.test.js` — ERC20, delegation, voting power, permit
- `DelegationHistory.test.js` — lần đầu / đổi / tự ủy quyền / lại cùng người / `delegateBySig` / phân trang
- `DelegateGovernor.test.js` — vòng đời, quorum, kết quả, cancel
- `Security.test.js` — snapshot bypass, bề mặt hàm ghi, `delegateBySig`/`permit`, bất biến event-vs-array
- `Gas.test.js` — đo chi phí history so với token không history

**Scripts & docs**
- `scripts/demo.js` — kịch bản demo đầu-cuối chạy bằng `truffle exec`
- `docs/ARCHITECTURE.md` (file này), `docs/DEMO.md`, `docs/SECURITY.md`, `README.md`

**AI engineering system** (Claude Code) — `CLAUDE.md`, `.claude/rules/*.md` (7 rule; rule có
`paths:` chỉ nạp khi làm việc với file khớp), `.claude/skills/*/SKILL.md` (6 skill),
`.claude/agents/*.md` (5 agent)

## 7. Rủi ro thiết kế chính

| # | Rủi ro | Mức độ | Cách xử lý |
|---|---|---|---|
| R1 | Hai nguồn lịch sử lệch nhau | Cao | Một điểm ghi duy nhất tại `_delegate` (§4.4) + test bất biến |
| R2 | `delegateBySig` lọt khỏi history | Cao | Override `_delegate`, không override `delegate` (§4.4) |
| R3 | Dùng `getVotes` thay `getPastVotes` → nhân đôi quyền lực | Cao | Snapshot bắt buộc + test chuyển token giữa kỳ vote |
| R4 | `votingDelay = 0` → `getPastVotes` revert ở OZ 5.x | Trung bình | Constructor bắt `votingDelay >= 1` |
| R5 | Mảng history tăng vô hạn → getter hết gas | Trung bình | Getter phân trang + `getDelegationCount` |
| R6 | Nhầm API OZ 4.x với 5.x | Trung bình | Đối chiếu trực tiếp `node_modules` trước khi viết (§1) |
| R7 | Quorum tính theo tổng cung hiện tại | Trung bình | Chốt `snapshotTotalSupply` khi tạo proposal |
| R8 | Giữ token mà tưởng là có quyền vote | Thấp | Ghi rõ ở README + demo in ra `getVotes` trước/sau delegate |
| R9 | Private key lọt vào repo | Cao | `.env` trong `.gitignore`, chỉ commit `.env.example` |
| R10 | Owner đổi `quorumNumerator` để lật kết quả proposal | Trung bình | **Đã sửa:** `quorumPercent` chốt trong `Proposal` + test (§5.3) |
| R11 | Owner tập trung quyền (mint, hủy proposal, đặt tham số) | Trung bình | Chấp nhận có chủ ý ở phạm vi đồ án; ghi trong `docs/SECURITY.md`, hướng đi: Timelock |

## 8. Kế hoạch theo giai đoạn

1. **Khảo sát + kiến trúc** — kiểm tra môi trường, chốt phiên bản, viết tài liệu này.
2. **AI instructions** — rules, skills, agents theo quy ước Claude Code.
3. **Đặc tả interface** — struct, event, chữ ký hàm, luồng delegation (§4, §5).
4. **Contracts + migrations** — viết code, compile.
5. **Tests** — viết test, chạy thật, sửa lỗi đến khi xanh.
6. **Bảo mật + tài liệu + demo** — rà soát, viết `SECURITY.md`, `DEMO.md`, script demo.

## 9. Tiêu chí nghiệm thu

**Chức năng**
- [x] Ủy quyền cho người khác; `getVotes(đại diện)` tăng đúng số token của người ủy quyền
- [x] Tự ủy quyền; `getVotes(chính mình)` bằng balance
- [x] Đổi đại diện; phiếu rời đại diện cũ sang đại diện mới, không mất mát
- [x] `getDelegationHistory` trả về đúng thứ tự thời gian, đúng `previousDelegate`/`newDelegate`
- [x] `delegateBySig` cũng được ghi vào history
- [x] Tạo proposal, vote For/Against/Abstain, đọc được kết quả và `state()`

**An toàn**
- [x] Vote lần hai bị revert
- [x] Token nhận sau snapshot không tạo thêm quyền vote
- [x] Chuyển token sau khi vote không đổi kết quả đã ghi
- [x] Proposal không đạt quorum → `Defeated` dù `forVotes > againstVotes`
- [x] Hàm quản trị revert với người gọi không phải owner
- [x] Không có private key / mnemonic trong repo

**Kỹ thuật**
- [x] `npm run compile` không lỗi, không warning đáng kể
- [x] `npm test` xanh toàn bộ, có kết quả thật dán vào README
- [x] `npm run migrate:dev` deploy thành công lên Ganache
- [x] `npm run demo` chạy hết kịch bản
- [x] Số phần tử mảng history **bằng** số event `DelegateChanged` (test bất biến)

**Còn mở**
- [ ] Rà soát bảo mật **độc lập** bằng agent `security-reviewer` trong phiên mới (`docs/SECURITY.md` hiện
  là tự rà soát của người viết code)
- [ ] Chạy phân tích tĩnh (Slither/solhint) và thử deploy Sepolia nếu giảng viên yêu cầu

Các mục đã đánh dấu được xác minh bằng: `npm test` (115 test dự án pass), `npm run migrate:dev`,
`npm run demo` chạy hết 7 bước, grep bí mật. Kết quả chi tiết ở README và `docs/SECURITY.md`.
