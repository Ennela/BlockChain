/**
 * Helper EVM tối giản cho test suite của DelegateDAO.
 *
 * Cố ý KHÔNG dùng `@openzeppelin/test-helpers`: package đó kéo theo web3 bản cũ và hay xung đột
 * trên Node mới. Mấy hàm dưới đây là tất cả những gì cần, và sinh viên đọc được hết trong 5 phút.
 */

/** Đào `count` block rỗng. Cần cho việc tiến tới/vượt qua cửa sổ bỏ phiếu. */
async function advanceBlocks(count) {
  for (let i = 0; i < count; i++) {
    await new Promise((resolve, reject) => {
      web3.currentProvider.send(
        { jsonrpc: '2.0', method: 'evm_mine', params: [], id: Date.now() + i },
        (err, res) => (err ? reject(err) : resolve(res))
      );
    });
  }
}

/** Block number hiện tại, dạng Number. */
async function currentBlock() {
  return Number(await web3.eth.getBlockNumber());
}

/** Đào block cho tới khi `block.number >= target`. */
async function advanceToBlock(target) {
  const now = await currentBlock();
  if (now < target) await advanceBlocks(target - now);
}

/**
 * ---------------------------------------------------------------------------
 * Decode custom error
 * ---------------------------------------------------------------------------
 *
 * Solidity 0.8.4+ và OpenZeppelin 5.x báo lỗi bằng **custom error** (ví dụ
 * `OwnableUnauthorizedAccount(address)`) thay vì require string. Truffle 5.11 không tra được tên
 * của chúng, chỉ in ra "Custom error (could not decode)".
 *
 * Giải pháp: lấy phần `error` trong ABI của các contract, tính selector 4 byte cho từng cái, rồi
 * dựng map selector → tên. Khi một transaction revert, ta đọc 4 byte đầu của revert data và tra map.
 *
 * Nhờ vậy test khẳng định được ĐÚNG loại lỗi, chứ không chỉ "có revert" — nếu không, một test
 * "revert đúng như mong đợi" có thể đang xanh vì một lỗi hoàn toàn khác.
 */

let _selectorToName = null;

function _buildErrorRegistry() {
  if (_selectorToName) return _selectorToName;
  _selectorToName = {};

  // Ba contract này mang theo toàn bộ custom error của chúng và của các contract OZ kế thừa.
  for (const name of ['GovernanceToken', 'DelegateGovernor', 'DelegationHistory']) {
    let abi;
    try {
      abi = artifacts.require(name).abi;
    } catch (e) {
      continue; // contract chưa compile — bỏ qua thay vì làm sập test
    }
    for (const entry of abi) {
      if (entry.type !== 'error') continue;
      const signature = `${entry.name}(${entry.inputs.map((i) => i.type).join(',')})`;
      _selectorToName[web3.eth.abi.encodeFunctionSignature(signature)] = entry.name;
    }
  }
  return _selectorToName;
}

/** Lấy revert data dạng hex từ object lỗi của Truffle, bất kể là transaction hay view call. */
function _extractRevertData(error) {
  const data = error.data;
  if (typeof data === 'string' && data.startsWith('0x')) return data;
  if (data && typeof data === 'object') {
    if (typeof data.result === 'string') return data.result;
    // Một số bản Truffle lồng kết quả theo tx hash.
    for (const value of Object.values(data)) {
      if (value && typeof value === 'object' && typeof value.return === 'string') {
        return value.return;
      }
    }
  }
  return null;
}

/** Tên custom error của một lỗi revert, hoặc null nếu không xác định được. */
function decodeCustomError(error) {
  const data = _extractRevertData(error);
  if (!data || data.length < 10) return null;
  return _buildErrorRegistry()[data.slice(0, 10)] || null;
}

/**
 * Khẳng định `promise` revert, và nếu truyền `expectedReason` thì lý do phải khớp.
 *
 * `expectedReason` có thể là tên custom error (`'OwnableUnauthorizedAccount'`) hoặc một đoạn của
 * require string. Hàm thử theo thứ tự: tên custom error đã decode → chuỗi trong message.
 */
async function expectRevert(promise, expectedReason) {
  try {
    await promise;
  } catch (error) {
    if (!expectedReason) return error;

    const customError = decodeCustomError(error);
    if (customError === expectedReason) return error;
    if (error.message.includes(expectedReason)) return error;

    throw new Error(
      `Revert sai lý do.\n` +
        `  Mong đợi      : ${expectedReason}\n` +
        `  Custom error  : ${customError || '(không decode được)'}\n` +
        `  Message       : ${error.message}`
    );
  }
  throw new Error(
    `Mong đợi transaction revert${expectedReason ? ` với "${expectedReason}"` : ''}, nhưng nó thành công.`
  );
}

/** Lấy các event tên `eventName` từ receipt của Truffle. */
function findEvents(receipt, eventName) {
  return receipt.logs.filter((log) => log.event === eventName);
}

/** Đổi số token sang wei (18 số thập phân). Nhận Number hoặc String. */
function tokens(amount) {
  return web3.utils.toWei(String(amount), 'ether');
}

/** Đổi wei về chuỗi token cho dễ đọc trong log. */
function fromTokens(wei) {
  return web3.utils.fromWei(String(wei), 'ether');
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

module.exports = {
  advanceBlocks,
  advanceToBlock,
  currentBlock,
  decodeCustomError,
  expectRevert,
  findEvents,
  tokens,
  fromTokens,
  ZERO_ADDRESS,
};
