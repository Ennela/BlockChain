// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title DelegationHistory
 * @notice Lưu trữ on-chain lịch sử thay đổi đại diện (delegate) của từng địa chỉ.
 *
 * @dev VÌ SAO CẦN CONTRACT NÀY?
 *
 * OpenZeppelin `Votes` đã emit event `DelegateChanged` mỗi lần delegation thay đổi. Event rất rẻ,
 * nhưng Solidity **không đọc được log của chính mình** — chỉ client off-chain lọc được. Đề bài yêu
 * cầu "ghi nhận VÀ truy vấn" lịch sử, nên cần một bản sao on-chain đọc được bằng `eth_call`.
 *
 * @dev THIẾT KẾ: ABSTRACT CONTRACT, KHÔNG PHẢI CONTRACT RIÊNG
 *
 * Nếu đây là contract độc lập thì `GovernanceToken` phải external call sang nó mỗi lần delegate.
 * Khi đó: hàm ghi phải public → ai cũng gọi được → history giả; và nếu một trong hai lệnh lỗi, hai
 * nguồn dữ liệu lệch nhau vĩnh viễn. Làm abstract contract với hàm ghi `internal` thì component vẫn
 * tách riêng về khái niệm, nhưng chạy trong cùng một transaction, cùng một contract.
 *
 * @dev BẤT BIẾN CỐT LÕI
 *
 * Contract kế thừa PHẢI gọi `_recordDelegation` từ đúng một chỗ: override `Votes._delegate()`.
 * Vì cả `delegate()` lẫn `delegateBySig()` đều đi qua `_delegate()`, mọi đường thay đổi delegation
 * đều được ghi. Kết quả: mảng history và chuỗi event `DelegateChanged` luôn có cùng số phần tử theo
 * cùng thứ tự. Xem `GovernanceToken._delegate` để biết cách nối đúng.
 *
 * @dev CHI PHÍ GAS — nói thẳng
 *
 * Mỗi record tốn 2 storage slot. Đo thật (test/Gas.test.js, OZ 5.1.0, solc 0.8.24, optimizer 200
 * runs, so với token cùng OZ nhưng không có history): thêm ~92k gas cho lần delegate đầu tiên trên
 * token mới và ~58k gas cho mỗi lần sau — bảng đầy đủ ở docs/ARCHITECTURE.md §4.5. Một DAO thương
 * mại sẽ chỉ emit event rồi index bằng subgraph. Đồ án này chọn on-chain vì đề bài cần truy vấn
 * được từ contract, và vì nó dễ demo hơn là dựng indexer. Đây là trade-off có chủ ý, không phải
 * thiếu sót.
 */
abstract contract DelegationHistory {
    /**
     * @notice Một lần thay đổi đại diện.
     *
     * @dev Đóng gói slot — thứ tự field ở đây là cố ý, không được đổi:
     *
     *   slot 1: previousDelegate (20B) + blockNumber (6B) + timestamp (6B) = 32B, vừa khít
     *   slot 2: newDelegate (20B)
     *
     * Nếu khai báo cả bốn field là 32 byte thì tốn 4 slot — đắt hơn ~44k gas mỗi lần delegate (suy
     * ra từ giá SSTORE vào slot trống, không đo riêng).
     * `uint48` đủ dùng: nó tràn vào khoảng năm 8.9 triệu.
     *
     * `previousDelegate` được lưu dù về lý thuyết suy ra được từ record trước đó. Nó nằm chung slot 1
     * với blockNumber và timestamp nên không thêm SSTORE (chưa đo riêng); đổi lại mỗi record tự đủ
     * nghĩa — client không phải đọc hai entry mới hiểu được một thay đổi.
     */
    struct DelegationRecord {
        address previousDelegate;
        uint48 blockNumber;
        uint48 timestamp;
        address newDelegate;
    }

    /// @dev delegator => danh sách thay đổi, theo thứ tự thời gian tăng dần. Chỉ append.
    mapping(address => DelegationRecord[]) private _history;

    /// @dev Tổng số lần delegation thay đổi trên toàn hệ thống. Hữu ích cho thống kê/demo.
    uint256 private _totalDelegationChanges;

    /**
     * @notice Phát ra mỗi khi một record mới được thêm vào lịch sử.
     * @dev Khác `DelegateChanged` của OZ: event này mang thêm `recordIndex` để client biết vị trí
     *      chính xác trong mảng mà không cần đếm lại.
     */
    event DelegationRecorded(
        address indexed delegator,
        address indexed previousDelegate,
        address indexed newDelegate,
        uint256 recordIndex,
        uint256 blockNumber,
        uint256 timestamp
    );

    /// @dev Tham số `offset` vượt quá độ dài mảng.
    error DelegationHistoryInvalidOffset(uint256 offset, uint256 length);

    /// @dev `limit` phải lớn hơn 0.
    error DelegationHistoryZeroLimit();

    /// @dev `delegator` chưa có record nào nên không có "record mới nhất" để trả về.
    error DelegationHistoryNoRecords(address delegator);

    // ---------------------------------------------------------------------
    // Ghi (internal — chỉ contract kế thừa gọi được)
    // ---------------------------------------------------------------------

    /**
     * @notice Thêm một record vào lịch sử của `delegator`.
     *
     * @dev CHỦ Ý: hàm này KHÔNG kiểm tra `previousDelegate != newDelegate`.
     *
     * OpenZeppelin vẫn emit `DelegateChanged` khi ủy quyền lại cho đúng người đang là đại diện. Nếu
     * ta bỏ qua trường hợp đó thì mảng và log sẽ lệch nhau — phá vỡ bất biến ở §4.4 của
     * docs/ARCHITECTURE.md. Ưu tiên giữ bất biến hơn là tiết kiệm một entry.
     *
     * @param delegator        Chủ token thay đổi đại diện.
     * @param previousDelegate Đại diện trước đó (address(0) nếu đây là lần ủy quyền đầu tiên).
     * @param newDelegate      Đại diện mới (bằng `delegator` nếu là tự ủy quyền).
     */
    function _recordDelegation(
        address delegator,
        address previousDelegate,
        address newDelegate
    ) internal {
        uint256 index = _history[delegator].length;

        _history[delegator].push(
            DelegationRecord({
                previousDelegate: previousDelegate,
                blockNumber: uint48(block.number),
                timestamp: uint48(block.timestamp),
                newDelegate: newDelegate
            })
        );

        unchecked {
            // Không thể overflow: mỗi lần tăng 1 cần một transaction.
            ++_totalDelegationChanges;
        }

        emit DelegationRecorded(
            delegator,
            previousDelegate,
            newDelegate,
            index,
            block.number,
            block.timestamp
        );
    }

    // ---------------------------------------------------------------------
    // Đọc
    // ---------------------------------------------------------------------

    /**
     * @notice Số lần `delegator` đã thay đổi đại diện.
     * @dev Gọi hàm này trước khi phân trang để biết tổng số record.
     */
    function getDelegationCount(address delegator) public view returns (uint256) {
        return _history[delegator].length;
    }

    /**
     * @notice Toàn bộ lịch sử delegation của `delegator`, cũ nhất trước.
     *
     * @dev CẢNH BÁO GAS: mảng tăng vô hạn theo số lần delegate. Hàm này an toàn khi gọi bằng
     *      `eth_call` (off-chain, miễn phí) với lượng record vừa phải, nhưng có thể vượt gas limit
     *      nếu một địa chỉ đổi đại diện hàng nghìn lần. Dùng `getDelegationHistoryPaginated` cho
     *      trường hợp đó, và đừng gọi hàm này từ trong một transaction.
     */
    function getDelegationHistory(
        address delegator
    ) public view returns (DelegationRecord[] memory) {
        return _history[delegator];
    }

    /**
     * @notice Một phần lịch sử delegation — dùng khi mảng đã lớn.
     *
     * @param delegator Địa chỉ cần tra cứu.
     * @param offset    Vị trí bắt đầu (0 là record cũ nhất).
     * @param limit     Số record tối đa trả về.
     * @return records  Lát cắt lịch sử; có thể ngắn hơn `limit` nếu đã tới cuối mảng.
     */
    function getDelegationHistoryPaginated(
        address delegator,
        uint256 offset,
        uint256 limit
    ) public view returns (DelegationRecord[] memory records) {
        if (limit == 0) revert DelegationHistoryZeroLimit();

        uint256 length = _history[delegator].length;

        // offset == length được phép và trả về mảng rỗng: giúp vòng lặp phân trang của client
        // kết thúc tự nhiên mà không cần kiểm tra biên riêng.
        if (offset > length) revert DelegationHistoryInvalidOffset(offset, length);

        uint256 available = length - offset;
        uint256 size = available < limit ? available : limit;

        records = new DelegationRecord[](size);
        for (uint256 i = 0; i < size; ++i) {
            records[i] = _history[delegator][offset + i];
        }
    }

    /**
     * @notice Record tại vị trí `index` trong lịch sử của `delegator`.
     * @dev Revert nếu `index` vượt biên (mảng Solidity tự kiểm tra).
     */
    function getDelegationRecord(
        address delegator,
        uint256 index
    ) public view returns (DelegationRecord memory) {
        return _history[delegator][index];
    }

    /**
     * @notice Record mới nhất của `delegator`.
     * @dev Revert `DelegationHistoryNoRecords` nếu địa chỉ chưa từng delegate. Kiểm tra
     *      `getDelegationCount > 0` trước khi gọi.
     */
    function getLatestDelegation(
        address delegator
    ) public view returns (DelegationRecord memory) {
        uint256 length = _history[delegator].length;
        if (length == 0) revert DelegationHistoryNoRecords(delegator);
        return _history[delegator][length - 1];
    }

    /// @notice Tổng số lần delegation thay đổi trên toàn bộ hệ thống.
    function totalDelegationChanges() public view returns (uint256) {
        return _totalDelegationChanges;
    }

    /**
     * @notice `delegator` đã từng delegate ít nhất một lần chưa.
     * @dev Phân biệt được "chưa bao giờ delegate" với "đã delegate rồi hủy về address(0)" —
     *      `delegates()` trả về address(0) trong cả hai trường hợp, hàm này thì không.
     */
    function hasDelegationHistory(address delegator) public view returns (bool) {
        return _history[delegator].length > 0;
    }
}
