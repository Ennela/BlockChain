/**
 * Helper ký EIP-712 cho `delegateBySig`.
 *
 * `delegateBySig` là entry point thứ hai có thể thay đổi delegation, và là lý do contract override
 * `_delegate` thay vì `delegate`. Không test được nó thì không chứng minh được rủi ro R2 đã xử lý,
 * nên phần này là bắt buộc phải có.
 *
 * CÁCH TIẾP CẬN: ký bằng RPC `eth_signTypedData_v4` của Ganache, không phải bằng private key.
 * Nhờ vậy test KHÔNG chứa private key hardcode nào, và không cần thêm dependency ký ngoài.
 * (Tuân thủ .claude/rules/05-security-and-secrets.md.)
 *
 * Chi tiết quan trọng: `delegateBySig` của OZ dùng domain separator khởi tạo trong
 * `ERC20Permit(name)`, với version cố định là "1".
 */

const EIP712_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

// Khớp struct hash trong Votes.delegateBySig của OZ.
const DELEGATION_TYPE = [
  { name: 'delegatee', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
];

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    web3.currentProvider.send(
      { jsonrpc: '2.0', method, params, id: Date.now() },
      (err, res) => {
        if (err) return reject(err);
        if (res && res.error) return reject(new Error(res.error.message));
        resolve(res.result);
      }
    );
  });
}

/**
 * Ký một message Delegation; trả về {v, r, s} để truyền vào `delegateBySig`.
 *
 * @param {object} token     Instance Truffle của GovernanceToken.
 * @param {string} signer    Địa chỉ ký (phải là account do Ganache quản lý).
 * @param {string} delegatee Địa chỉ nhận ủy quyền.
 * @param {number|string} nonce Nonce hiện tại của người ký — lấy từ `token.nonces(signer)`.
 * @param {number|string} expiry Deadline dạng unix timestamp.
 */
async function signTyped(token, signer, primaryType, fields, message) {
  const typedData = {
    types: { EIP712Domain: EIP712_DOMAIN, [primaryType]: fields },
    primaryType,
    domain: {
      name: await token.name(), // phải khớp tên truyền vào ERC20Permit
      version: '1', // EIP712(name, "1")
      chainId: Number(await web3.eth.getChainId()),
      verifyingContract: token.address,
    },
    message,
  };

  // Ganache cần object, không phải JSON string.
  const signature = await rpc('eth_signTypedData_v4', [signer, typedData]);
  return splitSignature(signature);
}

async function signDelegation(token, signer, delegatee, nonce, expiry) {
  return signTyped(token, signer, 'Delegation', DELEGATION_TYPE, {
    delegatee,
    nonce: String(nonce),
    expiry: String(expiry),
  });
}

// Khớp PERMIT_TYPEHASH trong ERC20Permit (ERC-2612). Dùng chung bộ đếm nonce với delegateBySig.
const PERMIT_TYPE = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];

async function signPermit(token, owner, spender, value, nonce, deadline) {
  return signTyped(token, owner, 'Permit', PERMIT_TYPE, {
    owner,
    spender,
    value: String(value),
    nonce: String(nonce),
    deadline: String(deadline),
  });
}

/** Tách chữ ký 65 byte thành {v, r, s}. */
function splitSignature(signature) {
  const r = '0x' + signature.slice(2, 66);
  const s = '0x' + signature.slice(66, 130);
  let v = parseInt(signature.slice(130, 132), 16);
  // Một số ví trả v = 0/1; ECDSA của OZ cần 27/28.
  if (v < 27) v += 27;
  return { v, r, s };
}

/** Deadline xa trong tương lai, dùng cho test không quan tâm hết hạn. */
function farFutureExpiry() {
  return Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
}

module.exports = { signDelegation, signPermit, splitSignature, farFutureExpiry };
