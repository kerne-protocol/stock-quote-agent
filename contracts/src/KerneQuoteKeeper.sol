// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IQuoteFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface ICoveredCallVault {
    function feed() external view returns (address);
    function openEpoch(uint256 strike, uint256 premiumBps, uint256 saleEnd, uint256 expiry) external returns (uint256);
}

/// @title KerneQuoteKeeper
/// @notice REFERENCE CONTRACT. NOT DEPLOYED. NOT AUDITED. It exists to show, in a fork test, how
///         the covered-call vault can take its strike and premium from the pricing agent's signed
///         quote instead of from a number typed by hand.
///
///         If this contract were set as the vault's keeper, the only way to open an epoch would be
///         `openFromQuote` with a quote that:
///           - is signed (EIP-712) by the pricing agent's key,
///           - names this vault and this vault's Chainlink feed,
///           - was priced on the feed round that is still the latest round (same id, same answer),
///           - has not passed its validUntil (the agent gives each quote 15 minutes).
///         The vault then applies its own owner-set floors (strike at least minOtmBps above spot,
///         premium at least minPremiumBps, duration limits) exactly as for any keeper.
///
///         A person still sends the transaction: only `operator` may call. The agent itself holds
///         no funds and sends nothing. The operator can choose WHETHER and WHEN to open, never the
///         strike or the premium.
contract KerneQuoteKeeper {
    struct Quote {
        address vault;
        address feed;
        uint80 roundId;
        uint256 spot;
        uint256 strike;
        uint32 premiumBps;
        uint64 saleWindow;
        uint64 expiry;
        uint64 validUntil;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address vault,address feed,uint80 roundId,uint256 spot,uint256 strike,uint32 premiumBps,uint64 saleWindow,uint64 expiry,uint64 validUntil)"
    );
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public immutable DOMAIN_SEPARATOR;
    ICoveredCallVault public immutable vault;
    IQuoteFeed public immutable feed;
    address public immutable quoteSigner;
    address public immutable operator;

    mapping(bytes32 => bool) public used;

    event OpenedFromQuote(uint256 indexed epoch, bytes32 indexed quoteDigest, uint256 strike, uint256 premiumBps, uint256 saleEnd, uint256 expiry);

    error NotOperator();
    error WrongMarket();
    error QuoteExpired();
    error QuoteStale();
    error QuoteUsed();
    error BadSignature();

    constructor(ICoveredCallVault vault_, address quoteSigner_, address operator_) {
        require(quoteSigner_ != address(0) && operator_ != address(0), "zero address");
        vault = vault_;
        feed = IQuoteFeed(vault_.feed());
        quoteSigner = quoteSigner_;
        operator = operator_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId)"),
                keccak256("KerneStockQuote"),
                keccak256("1"),
                block.chainid
            )
        );
    }

    function digestOf(Quote calldata q) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(QUOTE_TYPEHASH, q.vault, q.feed, q.roundId, q.spot, q.strike, q.premiumBps, q.saleWindow, q.expiry, q.validUntil)
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice Open the vault's next epoch at exactly the agent's quoted strike and premium.
    function openFromQuote(Quote calldata q, bytes calldata signature) external returns (uint256 epoch) {
        if (msg.sender != operator) revert NotOperator();
        if (q.vault != address(vault) || q.feed != address(feed)) revert WrongMarket();
        if (block.timestamp > q.validUntil) revert QuoteExpired();
        (uint80 roundId, int256 answer,,,) = feed.latestRoundData();
        if (roundId != q.roundId || answer <= 0 || uint256(answer) != q.spot) revert QuoteStale();

        bytes32 digest = digestOf(q);
        if (used[digest]) revert QuoteUsed();
        if (_recover(digest, signature) != quoteSigner) revert BadSignature();
        used[digest] = true;

        uint256 saleEnd = block.timestamp + q.saleWindow;
        if (saleEnd > q.expiry) saleEnd = q.expiry;
        epoch = vault.openEpoch(q.strike, q.premiumBps, saleEnd, q.expiry);
        emit OpenedFromQuote(epoch, digest, q.strike, q.premiumBps, saleEnd, q.expiry);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
