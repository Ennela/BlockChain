// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {DelegationHistory} from "./DelegationHistory.sol";

/**
 * @title GovernanceToken (DAOT)
 * @notice ERC-20 token quản trị có checkpoint voting power và lịch sử delegation truy vấn được.
 *
 * @dev KIẾN TRÚC KẾ THỪA
 *
 *   ERC20            — token cơ bản
 *   ERC20Permit      — approve bằng chữ ký (ERC-2612); cũng cung cấp EIP712 cho delegateBySig
 *   ERC20Votes       — checkpoint voting power + delegation (phần "khó" đều ở đây)
 *   Ownable          — chỉ owner được mint
 *   DelegationHistory— lịch sử delegation on-chain (code của đồ án)
 *
 * @dev ĐIỀU QUAN TRỌNG NHẤT CẦN HIỂU: TOKEN ≠ VOTING POWER
 *
 * Giữ token mà chưa gọi `delegate()` thì `getVotes()` trả về **0**. Đây là hành vi cố ý của
 * OpenZeppelin, không phải lỗi: quyền biểu quyết chỉ tồn tại sau khi được kích hoạt tường minh.
 * Người muốn tự bỏ phiếu phải gọi `delegate(địa_chỉ_của_chính_mình)`.
 *
 * @dev PHẦN TỰ VIẾT CHỈ LÀ ~10 DÒNG
 *
 * Toàn bộ checkpoint, binary search, ECDSA cho `delegateBySig` đều của OZ. Đồ án chỉ override
 * `_delegate()` để ghi thêm history. Đây là lý do contract này ngắn mà vẫn đủ chức năng.
 */
contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes, Ownable, DelegationHistory {
    /// @dev Vượt quá tổng cung tối đa.
    error GovernanceTokenMaxSupplyExceeded(uint256 requested, uint256 cap);

    /// @dev Không cho mint tới address(0) — ERC20 của OZ cũng chặn, đây là lỗi rõ nghĩa hơn.
    error GovernanceTokenInvalidReceiver();

    /**
     * @notice Tổng cung tối đa: 1 triệu token.
     * @dev `ERC20Votes` giới hạn tổng cung ở `type(uint208).max` vì checkpoint dùng uint208.
     *      Mức trần này nhỏ hơn rất nhiều nên luôn an toàn, và giúp demo có con số dễ nhìn.
     */
    uint256 public constant MAX_SUPPLY = 1_000_000e18;

    /**
     * @param initialOwner  Địa chỉ được quyền mint (thường là deployer; sau có thể chuyển cho DAO).
     * @param initialSupply Lượng token mint ngay cho `initialOwner`, đơn vị wei (18 số thập phân).
     *
     * @dev Lưu ý: `initialOwner` nhận token nhưng **chưa có voting power** cho tới khi gọi
     *      `delegate()`. Migration script sẽ tự delegate để demo chạy được ngay.
     */
    constructor(
        address initialOwner,
        uint256 initialSupply
    ) ERC20("DelegateDAO Token", "DAOT") ERC20Permit("DelegateDAO Token") Ownable(initialOwner) {
        if (initialSupply > MAX_SUPPLY) {
            revert GovernanceTokenMaxSupplyExceeded(initialSupply, MAX_SUPPLY);
        }
        if (initialSupply > 0) {
            _mint(initialOwner, initialSupply);
        }
    }

    // ---------------------------------------------------------------------
    // Mint
    // ---------------------------------------------------------------------

    /**
     * @notice Mint token mới. Chỉ owner.
     * @dev Mint tạo checkpoint voting power cho *đại diện hiện tại* của `to` (nếu có), nhưng
     *      **không** tạo record trong delegation history — nhận token không phải là thay đổi quan hệ
     *      ủy quyền. Phân biệt này được kiểm tra trong test.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert GovernanceTokenInvalidReceiver();
        if (totalSupply() + amount > MAX_SUPPLY) {
            revert GovernanceTokenMaxSupplyExceeded(totalSupply() + amount, MAX_SUPPLY);
        }
        _mint(to, amount);
    }

    /// @notice Lượng token còn có thể mint.
    function remainingMintableSupply() external view returns (uint256) {
        return MAX_SUPPLY - totalSupply();
    }

    // ---------------------------------------------------------------------
    // Nối delegation history vào OpenZeppelin — TRÁI TIM CỦA ĐỒ ÁN
    // ---------------------------------------------------------------------

    /**
     * @notice Ghi lại mọi thay đổi đại diện trước khi chuyển cho OpenZeppelin xử lý.
     *
     * @dev VÌ SAO OVERRIDE `_delegate` MÀ KHÔNG PHẢI `delegate`?
     *
     * `Votes` có hai entry point công khai:
     *   - `delegate(delegatee)`                      — người gọi tự delegate
     *   - `delegateBySig(delegatee, nonce, ...)`     — delegate bằng chữ ký, người gửi tx là ai cũng được
     *
     * Cả hai đều gọi nội bộ `_delegate()` (xem Votes.sol:160 cho đường delegateBySig). Override
     * `_delegate` bắt được **cả hai**. Nếu chỉ override `delegate`, mọi delegation bằng chữ ký sẽ
     * lọt khỏi lịch sử — đây chính là rủi ro R2 trong docs/ARCHITECTURE.md.
     *
     * @dev THỨ TỰ LỆNH LÀ BẮT BUỘC
     *
     * `delegates(account)` phải được đọc **trước** `super._delegate()`, vì `super` sẽ ghi đè giá trị
     * đó. Đảo thứ tự thì `previousDelegate` sẽ bằng `newDelegate` ở mọi record — một bug âm thầm mà
     * test `Security.test.js` kiểm tra riêng.
     */
    function _delegate(address account, address delegatee) internal override {
        _recordDelegation(account, delegates(account), delegatee);
        super._delegate(account, delegatee);
    }

    // ---------------------------------------------------------------------
    // Override bắt buộc do đa kế thừa (Solidity yêu cầu nêu rõ thứ tự)
    // ---------------------------------------------------------------------

    /**
     * @dev `ERC20` và `ERC20Votes` đều định nghĩa `_update`. Solidity buộc ta chỉ rõ thứ tự gọi.
     *      `ERC20Votes._update` gọi `super._update` (tức ERC20) rồi mới dịch chuyển checkpoint, nên
     *      khai báo này chuyển token và cập nhật voting power đúng một lần, đúng thứ tự.
     */
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    /**
     * @dev `ERC20Permit` và `Nonces` đều khai báo `nonces`. Cả hai cùng đọc một biến đếm trong
     *      `Nonces`, nên nonce dùng cho `permit` và cho `delegateBySig` là **cùng một chuỗi**.
     *      Hệ quả thực tế: gọi `permit` làm tăng nonce, nên chữ ký `delegateBySig` ký trước đó sẽ
     *      không còn hợp lệ. Test có trường hợp cho điều này.
     */
    function nonces(
        address owner
    ) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
