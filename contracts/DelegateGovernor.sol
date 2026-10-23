// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title DelegateGovernor
 * @notice Quản lý proposal, cửa sổ bỏ phiếu, quorum và kết quả cho DelegateDAO.
 *
 * @dev VÌ SAO KHÔNG DÙNG `Governor` CỦA OPENZEPPELIN?
 *
 * OZ có bộ Governor đầy đủ (GovernorSettings + GovernorCountingSimple + GovernorVotes +
 * GovernorVotesQuorumFraction + GovernorTimelockControl). Đó là công cụ sản xuất: execution bằng
 * calldata tùy ý, timelock, clock theo timestamp, proposal threshold, relay... vài nghìn dòng mà
 * sinh viên không giải thích được trong buổi bảo vệ.
 *
 * Đề bài trọng tâm là delegation history, nên contract này viết tay cho gọn — NHƯNG vẫn tái sử dụng
 * OZ ở mọi chỗ an toàn-quan trọng:
 *   - `IVotes` của OZ, không tự định nghĩa interface.
 *   - Toàn bộ snapshot/checkpoint do `ERC20Votes` lo. Governor chỉ ĐỌC, không tự quản lý số phiếu.
 *   - `Ownable` của OZ cho quyền quản trị tham số.
 *
 * Phần khó (binary search trên checkpoint, ECDSA) để OZ làm. Phần tự viết chỉ là vòng đời proposal.
 *
 * @dev GIỚI HẠN PHẠM VI ĐƯỢC GHI RÕ
 *
 * `execute()` chỉ đánh dấu proposal đã thực thi và emit event — KHÔNG chạy calldata tùy ý. Một
 * governor thực thi được calldata bất kỳ cần Timelock, kiểm soát re-entrancy và quản lý quyền cẩn
 * thận, vượt xa phạm vi đồ án. Đây là giới hạn có chủ ý, không phải lỗ hổng bị bỏ sót. Hướng mở rộng
 * đúng là `GovernorTimelockControl` của OZ.
 */
contract DelegateGovernor is Ownable {
    using SafeCast for uint256;

    // ---------------------------------------------------------------------
    // Kiểu dữ liệu
    // ---------------------------------------------------------------------

    /// @notice Lựa chọn khi bỏ phiếu. Giá trị số khớp quy ước `GovernorCountingSimple` của OZ.
    enum VoteType {
        Against, // 0
        For, // 1
        Abstain // 2
    }

    /**
     * @notice Trạng thái proposal.
     * @dev Được TÍNH từ block hiện tại và số phiếu — không có hàm nào "chuyển trạng thái". Nhờ vậy
     *      không tồn tại trạng thái mồ côi do thiếu một lệnh gọi; trạng thái luôn tự đúng.
     */
    enum ProposalState {
        Pending, // đã tạo, chưa tới kỳ bỏ phiếu
        Active, // đang bỏ phiếu
        Defeated, // hết hạn: thiếu quorum hoặc Against >= For
        Succeeded, // hết hạn: đủ quorum và For > Against
        Executed, // đã gọi execute()
        Canceled // đã bị hủy
    }

    /**
     * @dev Đóng gói slot: slot 1 = proposer+snapshotBlock+voteStart (20+6+6 = 32B);
     *      slot 2 = voteEnd+executed+canceled+quorumPercent (6+1+1+1 = 9B), phần còn lại để trống.
     */
    struct Proposal {
        address proposer;
        uint48 snapshotBlock; // quyền biểu quyết được chốt tại block này
        uint48 voteStart; // = snapshotBlock + 1
        uint48 voteEnd;
        bool executed;
        bool canceled;
        uint8 quorumPercent; // quorumNumerator chốt lúc tạo; đổi tham số sau đó không ảnh hưởng
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 snapshotTotalSupply; // chốt quorum tại cùng block, xem lý do ở createProposal
        string description;
    }

    /// @notice Phiếu của một địa chỉ trên một proposal.
    struct Receipt {
        bool hasVoted;
        uint8 support; // VoteType dạng số
        uint256 votes; // số phiếu đã dùng, ghi lại để audit
    }

    // ---------------------------------------------------------------------
    // Trạng thái
    // ---------------------------------------------------------------------

    /// @notice Token quản trị cung cấp voting power. Immutable — không đổi được sau deploy.
    IVotes public immutable token;

    /// @notice Số block chờ từ lúc tạo proposal đến khi mở bỏ phiếu.
    uint256 public votingDelay;

    /// @notice Độ dài cửa sổ bỏ phiếu, tính bằng block.
    uint256 public votingPeriod;

    /// @notice Phần trăm tổng cung tại snapshot cần tham gia để proposal hợp lệ (1-100).
    uint256 public quorumNumerator;

    /// @dev Mẫu số của quorum. Cố định 100 để `quorumNumerator` đọc trực tiếp là phần trăm.
    uint256 public constant QUORUM_DENOMINATOR = 100;

    /// @notice Độ dài tối đa của description, chặn spam làm phình storage.
    uint256 public constant MAX_DESCRIPTION_LENGTH = 1000;

    uint256 private _proposalCount;
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => Receipt)) private _receipts;

    // ---------------------------------------------------------------------
    // Event
    // ---------------------------------------------------------------------

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        string description,
        uint256 snapshotBlock,
        uint256 voteStart,
        uint256 voteEnd,
        uint256 snapshotTotalSupply
    );

    event VoteCast(
        address indexed voter,
        uint256 indexed proposalId,
        uint8 support,
        uint256 votes,
        string reason
    );

    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCanceled(uint256 indexed proposalId);
    event VotingDelayUpdated(uint256 oldValue, uint256 newValue);
    event VotingPeriodUpdated(uint256 oldValue, uint256 newValue);
    event QuorumNumeratorUpdated(uint256 oldValue, uint256 newValue);

    // ---------------------------------------------------------------------
    // Error
    // ---------------------------------------------------------------------

    error GovernorInvalidTokenAddress();
    error GovernorInvalidVotingDelay();
    error GovernorInvalidVotingPeriod();
    error GovernorInvalidQuorumNumerator(uint256 value);
    error GovernorEmptyDescription();
    error GovernorDescriptionTooLong(uint256 length, uint256 maxLength);
    error GovernorNonexistentProposal(uint256 proposalId);
    error GovernorProposalNotActive(uint256 proposalId, ProposalState state);
    error GovernorAlreadyVoted(uint256 proposalId, address voter);
    error GovernorNoVotingPower(address voter, uint256 snapshotBlock);
    error GovernorInvalidVoteType(uint8 support);
    error GovernorProposalNotSucceeded(uint256 proposalId, ProposalState state);
    error GovernorCannotCancel(uint256 proposalId, ProposalState state);
    error GovernorUnauthorizedCancel(address caller);
    error GovernorNoVotingPowerToPropose(address proposer);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @param token_          Địa chỉ GovernanceToken (phải triển khai IVotes).
     * @param votingDelay_    Số block chờ trước khi mở bỏ phiếu. **Phải >= 1**, xem lý do bên dưới.
     * @param votingPeriod_   Độ dài kỳ bỏ phiếu, tính bằng block. Phải >= 1.
     * @param quorumNumerator_ Phần trăm quorum, 1-100.
     *
     * @dev VÌ SAO `votingDelay >= 1` LÀ BẮT BUỘC?
     *
     * `Votes.getPastVotes` của OZ 5.1.0 revert với `ERC5805FutureLookup` nếu timepoint chưa thực sự
     * qua (xem Votes.sol:91-92 — điều kiện là `timepoint >= clock()`).
     * Nếu `votingDelay = 0` thì `snapshotBlock == block.number` lúc tạo proposal, và mọi lệnh vote ở
     * cùng block đó sẽ revert. Đây là rủi ro R4 trong docs/ARCHITECTURE.md; constructor chặn ngay từ
     * đầu thay vì để lỗi xuất hiện lúc demo.
     */
    constructor(
        address token_,
        uint256 votingDelay_,
        uint256 votingPeriod_,
        uint256 quorumNumerator_,
        address initialOwner
    ) Ownable(initialOwner) {
        if (token_ == address(0)) revert GovernorInvalidTokenAddress();
        if (votingDelay_ < 1) revert GovernorInvalidVotingDelay();
        if (votingPeriod_ < 1) revert GovernorInvalidVotingPeriod();
        if (quorumNumerator_ == 0 || quorumNumerator_ > QUORUM_DENOMINATOR) {
            revert GovernorInvalidQuorumNumerator(quorumNumerator_);
        }

        token = IVotes(token_);
        votingDelay = votingDelay_;
        votingPeriod = votingPeriod_;
        quorumNumerator = quorumNumerator_;
    }

    // ---------------------------------------------------------------------
    // Tạo proposal
    // ---------------------------------------------------------------------

    /**
     * @notice Tạo proposal mới.
     *
     * @dev Yêu cầu người tạo có voting power > 0 tại block trước đó — chặn spam từ ví rỗng. Lưu ý
     *      đây là kiểm tra "có quyền biểu quyết", nên người giữ token mà chưa `delegate()` sẽ không
     *      tạo được proposal. Đó là hệ quả đúng của mô hình: chưa kích hoạt quyền thì chưa dùng được.
     *
     * @dev VÌ SAO CHỐT CẢ `snapshotTotalSupply`?
     *
     * Nếu quorum tính theo `totalSupply()` hiện tại, việc mint thêm token giữa kỳ bỏ phiếu sẽ làm
     * ngưỡng quorum "chạy" — một proposal đang đủ quorum có thể bỗng thiếu. Chốt tổng cung tại cùng
     * block với snapshot phiếu khiến ngưỡng bất biến suốt kỳ vote. (Rủi ro R7.)
     *
     * @return proposalId Id tuần tự, bắt đầu từ 1.
     */
    function createProposal(string calldata description) external returns (uint256 proposalId) {
        uint256 length = bytes(description).length;
        if (length == 0) revert GovernorEmptyDescription();
        if (length > MAX_DESCRIPTION_LENGTH) {
            revert GovernorDescriptionTooLong(length, MAX_DESCRIPTION_LENGTH);
        }

        // block.number - 1 vì getPastVotes yêu cầu timepoint đã qua.
        if (token.getPastVotes(msg.sender, block.number - 1) == 0) {
            revert GovernorNoVotingPowerToPropose(msg.sender);
        }

        unchecked {
            proposalId = ++_proposalCount; // bắt đầu từ 1; id 0 dành cho "không tồn tại"
        }

        // toUint48 (OZ SafeCast) revert khi tràn; ép kiểu `uint48(x)` trần sẽ cắt bớt bit thầm lặng,
        // và owner đặt votingPeriod ≥ 2^48 sẽ làm voteEnd quay vòng về số nhỏ.
        uint48 snapshotBlock = (block.number + votingDelay).toUint48();
        uint48 voteStart = snapshotBlock + 1;
        uint48 voteEnd = (voteStart + votingPeriod - 1).toUint48();

        Proposal storage proposal = _proposals[proposalId];
        proposal.proposer = msg.sender;
        proposal.snapshotBlock = snapshotBlock;
        proposal.voteStart = voteStart;
        proposal.voteEnd = voteEnd;
        proposal.description = description;
        proposal.quorumPercent = uint8(quorumNumerator); // an toàn: luôn trong 1..100
        // Tổng cung tại block trước; snapshotBlock còn ở tương lai nên chưa đọc được.
        // Chênh lệch chỉ xảy ra nếu có mint trong khoảng votingDelay — chấp nhận được, và vẫn
        // bất biến suốt kỳ vote, đó mới là điều quan trọng.
        proposal.snapshotTotalSupply = token.getPastTotalSupply(block.number - 1);

        emit ProposalCreated(
            proposalId,
            msg.sender,
            description,
            snapshotBlock,
            voteStart,
            voteEnd,
            proposal.snapshotTotalSupply
        );
    }

    // ---------------------------------------------------------------------
    // Bỏ phiếu
    // ---------------------------------------------------------------------

    /// @notice Bỏ phiếu không kèm lý do.
    function castVote(uint256 proposalId, uint8 support) external returns (uint256) {
        return _castVote(proposalId, msg.sender, support, "");
    }

    /// @notice Bỏ phiếu kèm lý do công khai (lưu trong event, không lưu storage).
    function castVoteWithReason(
        uint256 proposalId,
        uint8 support,
        string calldata reason
    ) external returns (uint256) {
        return _castVote(proposalId, msg.sender, support, reason);
    }

    /**
     * @dev Ba cơ chế bảo vệ nằm trong hàm này:
     *
     *  1. SNAPSHOT — phiếu đọc bằng `getPastVotes(voter, snapshotBlock)`, không phải `getVotes`.
     *     Nếu dùng `getVotes`, một người có thể vote → chuyển token sang ví khác → ví đó delegate
     *     rồi vote lại, nhân đôi quyền lực. Snapshot khử hẳn đường đó. (Rủi ro R3.)
     *
     *  2. CHỐNG DOUBLE VOTING — `receipt.hasVoted`. Chặn theo **người bỏ phiếu**, không theo người
     *     ủy quyền: nếu A ủy quyền cho B thì chỉ B vote được, một lần, với tổng phiếu của cả hai.
     *
     *  3. CHẶN PHIẾU RỖNG — `votes == 0` thì revert. Không có tác dụng bảo mật trực tiếp nhưng cho
     *     người dùng thông báo rõ ("bạn chưa delegate") thay vì một phiếu im lặng không ảnh hưởng gì.
     */
    function _castVote(
        uint256 proposalId,
        address voter,
        uint8 support,
        string memory reason
    ) private returns (uint256 votes) {
        _requireProposalExists(proposalId);

        if (support > uint8(VoteType.Abstain)) revert GovernorInvalidVoteType(support);

        ProposalState currentState = state(proposalId);
        if (currentState != ProposalState.Active) {
            revert GovernorProposalNotActive(proposalId, currentState);
        }

        Receipt storage receipt = _receipts[proposalId][voter];
        if (receipt.hasVoted) revert GovernorAlreadyVoted(proposalId, voter);

        Proposal storage proposal = _proposals[proposalId];
        votes = token.getPastVotes(voter, proposal.snapshotBlock);
        if (votes == 0) revert GovernorNoVotingPower(voter, proposal.snapshotBlock);

        receipt.hasVoted = true;
        receipt.support = support;
        receipt.votes = votes;

        if (support == uint8(VoteType.For)) {
            proposal.forVotes += votes;
        } else if (support == uint8(VoteType.Against)) {
            proposal.againstVotes += votes;
        } else {
            proposal.abstainVotes += votes;
        }

        emit VoteCast(voter, proposalId, support, votes, reason);
    }

    // ---------------------------------------------------------------------
    // Thực thi và hủy
    // ---------------------------------------------------------------------

    /**
     * @notice Đánh dấu một proposal đã thắng là đã thực thi.
     * @dev KHÔNG chạy calldata — xem ghi chú giới hạn phạm vi ở đầu contract. Ai cũng gọi được, vì
     *      proposal đã thắng thì việc ghi nhận kết quả không cần đặc quyền.
     */
    function execute(uint256 proposalId) external {
        _requireProposalExists(proposalId);

        ProposalState currentState = state(proposalId);
        if (currentState != ProposalState.Succeeded) {
            revert GovernorProposalNotSucceeded(proposalId, currentState);
        }

        _proposals[proposalId].executed = true;
        emit ProposalExecuted(proposalId);
    }

    /**
     * @notice Hủy proposal khi còn Pending hoặc Active.
     * @dev Chỉ người tạo proposal hoặc owner. Không hủy được proposal đã kết thúc — nếu không, owner
     *      có thể xóa một kết quả không vừa ý sau khi đã biết nó.
     */
    function cancel(uint256 proposalId) external {
        _requireProposalExists(proposalId);

        Proposal storage proposal = _proposals[proposalId];
        if (msg.sender != proposal.proposer && msg.sender != owner()) {
            revert GovernorUnauthorizedCancel(msg.sender);
        }

        ProposalState currentState = state(proposalId);
        if (currentState != ProposalState.Pending && currentState != ProposalState.Active) {
            revert GovernorCannotCancel(proposalId, currentState);
        }

        proposal.canceled = true;
        emit ProposalCanceled(proposalId);
    }

    // ---------------------------------------------------------------------
    // Đọc trạng thái
    // ---------------------------------------------------------------------

    /**
     * @notice Trạng thái hiện tại của proposal.
     * @dev Thứ tự kiểm tra quan trọng: canceled và executed là cờ tường minh nên xét trước; phần còn
     *      lại suy ra từ block hiện tại và số phiếu.
     */
    function state(uint256 proposalId) public view returns (ProposalState) {
        _requireProposalExists(proposalId);
        Proposal storage proposal = _proposals[proposalId];

        if (proposal.canceled) return ProposalState.Canceled;
        if (proposal.executed) return ProposalState.Executed;
        if (block.number < proposal.voteStart) return ProposalState.Pending;
        if (block.number <= proposal.voteEnd) return ProposalState.Active;

        return _voteSucceeded(proposal) ? ProposalState.Succeeded : ProposalState.Defeated;
    }

    /**
     * @dev Điều kiện thắng: For > Against **và** For + Abstain >= quorum.
     *
     *      Abstain tính vào quorum nhưng không tính vào thắng/thua — đúng quy ước
     *      `GovernorCountingSimple` của OZ. Ý nghĩa: phiếu trắng là "tôi có tham gia nhưng không
     *      chọn bên", nên nó giúp proposal đạt ngưỡng tham gia mà không nghiêng kết quả.
     */
    function _voteSucceeded(Proposal storage proposal) private view returns (bool) {
        uint256 participating = proposal.forVotes + proposal.abstainVotes;
        return proposal.forVotes > proposal.againstVotes && participating >= _quorum(proposal);
    }

    function _quorum(Proposal storage proposal) private view returns (uint256) {
        return (proposal.snapshotTotalSupply * proposal.quorumPercent) / QUORUM_DENOMINATOR;
    }

    /// @notice Số phiếu cần để proposal đạt quorum.
    function quorumVotes(uint256 proposalId) external view returns (uint256) {
        _requireProposalExists(proposalId);
        return _quorum(_proposals[proposalId]);
    }

    /// @notice Toàn bộ thông tin proposal.
    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        _requireProposalExists(proposalId);
        return _proposals[proposalId];
    }

    /// @notice Kết quả kiểm phiếu hiện tại.
    function proposalVotes(
        uint256 proposalId
    ) external view returns (uint256 forVotes, uint256 againstVotes, uint256 abstainVotes) {
        _requireProposalExists(proposalId);
        Proposal storage proposal = _proposals[proposalId];
        return (proposal.forVotes, proposal.againstVotes, proposal.abstainVotes);
    }

    /// @notice Phiếu của `voter` trên `proposalId`.
    function getReceipt(
        uint256 proposalId,
        address voter
    ) external view returns (Receipt memory) {
        _requireProposalExists(proposalId);
        return _receipts[proposalId][voter];
    }

    /// @notice `voter` đã bỏ phiếu trên `proposalId` chưa.
    function hasVoted(uint256 proposalId, address voter) external view returns (bool) {
        _requireProposalExists(proposalId);
        return _receipts[proposalId][voter].hasVoted;
    }

    /// @notice Tổng số proposal đã tạo. Id hợp lệ là 1..proposalCount().
    function proposalCount() external view returns (uint256) {
        return _proposalCount;
    }

    /**
     * @notice Số phiếu `voter` có thể dùng cho `proposalId`.
     * @dev Trả về 0 nếu snapshot chưa tới (thay vì revert như `getPastVotes`), để UI gọi được ngay
     *      sau khi tạo proposal mà không cần xử lý lỗi.
     */
    function getVotingPowerForProposal(
        uint256 proposalId,
        address voter
    ) external view returns (uint256) {
        _requireProposalExists(proposalId);
        uint256 snapshotBlock = _proposals[proposalId].snapshotBlock;
        if (block.number <= snapshotBlock) return 0;
        return token.getPastVotes(voter, snapshotBlock);
    }

    // ---------------------------------------------------------------------
    // Quản trị tham số (chỉ owner)
    // ---------------------------------------------------------------------

    /**
     * @dev Thay đổi tham số chỉ áp dụng cho proposal TẠO SAU đó: `snapshotBlock`, `voteStart`,
     *      `voteEnd`, `quorumPercent` và `snapshotTotalSupply` đều đã được ghi vào storage lúc tạo.
     *      Nhờ vậy owner không thể lật kết quả của proposal đang mở hay đã kết thúc bằng cách đổi
     *      tham số. Owner vẫn tập trung quyền (mint, hủy proposal) — một DAO thật sẽ đặt các quyền
     *      này sau Timelock; xem docs/SECURITY.md.
     */
    function setVotingDelay(uint256 newVotingDelay) external onlyOwner {
        if (newVotingDelay < 1) revert GovernorInvalidVotingDelay();
        emit VotingDelayUpdated(votingDelay, newVotingDelay);
        votingDelay = newVotingDelay;
    }

    function setVotingPeriod(uint256 newVotingPeriod) external onlyOwner {
        if (newVotingPeriod < 1) revert GovernorInvalidVotingPeriod();
        emit VotingPeriodUpdated(votingPeriod, newVotingPeriod);
        votingPeriod = newVotingPeriod;
    }

    function setQuorumNumerator(uint256 newQuorumNumerator) external onlyOwner {
        if (newQuorumNumerator == 0 || newQuorumNumerator > QUORUM_DENOMINATOR) {
            revert GovernorInvalidQuorumNumerator(newQuorumNumerator);
        }
        emit QuorumNumeratorUpdated(quorumNumerator, newQuorumNumerator);
        quorumNumerator = newQuorumNumerator;
    }

    // ---------------------------------------------------------------------
    // Nội bộ
    // ---------------------------------------------------------------------

    function _requireProposalExists(uint256 proposalId) private view {
        if (proposalId == 0 || proposalId > _proposalCount) {
            revert GovernorNonexistentProposal(proposalId);
        }
    }
}
