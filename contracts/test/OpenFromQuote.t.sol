// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {KerneQuoteKeeper, ICoveredCallVault} from "../src/KerneQuoteKeeper.sol";

interface ILiveVault {
    function owner() external view returns (address);
    function keeper() external view returns (address);
    function asset() external view returns (address);
    function feed() external view returns (address);
    function setKeeper(address) external;
    function setParams(uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256) external;
    function maxStaleness() external view returns (uint256);
    function minOtmBps() external view returns (uint256);
    function minPremiumBps() external view returns (uint256);
    function minDuration() external view returns (uint256);
    function maxDuration() external view returns (uint256);
    function fallbackDelay() external view returns (uint256);
    function idleWindow() external view returns (uint256);
    function epochLive() external view returns (bool);
    function currentEpoch() external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function spotPrice() external view returns (uint256);
    function deposit(uint256, address) external returns (uint256);
    function buyCall(uint256, uint256) external returns (uint256);
    function openEpoch(uint256, uint256, uint256, uint256) external returns (uint256);
    function epochs(uint256)
        external
        view
        returns (uint128 strike, uint64 saleEnd, uint64 expiry, uint32 premiumBps, uint128 capacity, uint128 sold, uint128 premium, uint128 settlePrice, uint128 payoutTotal, bool settled);
}

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @dev Stand-in for the TSLAc token. Coinbase B20 stocks are precompiles that a local fork cannot
///      execute, so the test puts this code at the real TSLAc address. The vault only uses the
///      ERC-20 surface.
contract MockStock {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// @notice Fork tests on Base mainnet: the DEPLOYED covered-call vault opens an epoch from the
///         pricing agent's signed quote, through the reference keeper contract.
///
///         Nothing here touches mainnet. The owner is impersonated on a local fork to point the
///         vault's keeper at the reference contract and to lift the deposit cap.
///
///         Run:  FORK_TESTS=1 forge test -vv
///         Optional: BASE_RPC=<an archive-capable Base RPC>
contract OpenFromQuoteTest is Test {
    ILiveVault constant VAULT = ILiveVault(0xc6180E9af7Cb4c6D47A230a6c5047fA615Bd0956);
    address constant TSLAC = 0xb2000000000000000000001e800a7f5189430cD0;
    address constant TSLA_FEED = 0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4;
    /// The pricing agent's published signer (https://kerne-stock-quote.r4woutreach.workers.dev/api/signer).
    address constant AGENT_SIGNER = 0x9653Bf177239C979921DC8C0639eD00409F4Db88;

    address lp = makeAddr("lp");
    address buyer = makeAddr("buyer");
    address stranger = makeAddr("stranger");

    function _rpc() internal view returns (string memory) {
        return vm.envOr("BASE_RPC", string("https://mainnet.base.org"));
    }

    /// Fork setup shared by both tests: mock stock at the real address, reference keeper installed
    /// by the (impersonated) owner, deposit cap lifted, 10 stock deposited.
    function _prepare(address quoteSigner) internal returns (KerneQuoteKeeper k, address owner) {
        assertEq(VAULT.asset(), TSLAC, "vault asset");
        assertEq(VAULT.feed(), TSLA_FEED, "vault feed");
        vm.etch(TSLAC, address(new MockStock()).code);
        owner = VAULT.owner();
        k = new KerneQuoteKeeper(ICoveredCallVault(address(VAULT)), quoteSigner, owner);
        vm.startPrank(owner);
        VAULT.setKeeper(address(k));
        VAULT.setParams(
            100e8, VAULT.maxStaleness(), VAULT.minOtmBps(), VAULT.minPremiumBps(), VAULT.minDuration(), VAULT.maxDuration(), VAULT.fallbackDelay(), VAULT.idleWindow()
        );
        vm.stopPrank();
        MockStock(TSLAC).mint(lp, 10e8);
        MockStock(TSLAC).mint(buyer, 1e8);
        vm.prank(lp);
        MockStock(TSLAC).approve(address(VAULT), type(uint256).max);
        vm.prank(buyer);
        MockStock(TSLAC).approve(address(VAULT), type(uint256).max);
        vm.prank(lp);
        VAULT.deposit(10e8, lp);
    }

    /// Memory structs are references, so edits for the negative cases are made on a copy.
    function _copy(KerneQuoteKeeper.Quote memory q) internal pure returns (KerneQuoteKeeper.Quote memory) {
        return KerneQuoteKeeper.Quote(q.vault, q.feed, q.roundId, q.spot, q.strike, q.premiumBps, q.saleWindow, q.expiry, q.validUntil);
    }

    function _sign(KerneQuoteKeeper k, KerneQuoteKeeper.Quote memory q, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, k.digestOf(q));
        return abi.encodePacked(r, s, v);
    }

    function _assertOpened(KerneQuoteKeeper.Quote memory q, uint256 id, uint256 openedAt) internal view {
        assertTrue(VAULT.epochLive(), "epoch live");
        assertEq(VAULT.currentEpoch(), id);
        (uint128 strike, uint64 saleEnd, uint64 expiry, uint32 premiumBps, uint128 capacity,,,,,) = VAULT.epochs(id);
        assertEq(strike, q.strike, "strike is the quoted strike");
        assertEq(premiumBps, q.premiumBps, "premium is the quoted premium");
        assertEq(expiry, q.expiry, "expiry is the quoted expiry");
        assertEq(saleEnd, openedAt + q.saleWindow, "sale window");
        assertEq(capacity, 10e8, "capacity is the deposited stock");
    }

    /// The main demonstration: a quote produced and signed by the LIVE agent (saved from its public
    /// endpoint into test/fixtures/live_quote.json) opens an epoch on the deployed vault, on a fork
    /// pinned to the block the agent priced at.
    function test_deployedVaultOpensEpochFromLiveAgentQuote() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        string memory j = vm.readFile("test/fixtures/live_quote.json");
        assertEq(vm.parseJsonString(j, ".status"), "QUOTE_OK", "fixture must hold a quote");
        assertEq(vm.parseJsonAddress(j, ".signer"), AGENT_SIGNER, "fixture signer is the live agent");
        KerneQuoteKeeper.Quote memory q = KerneQuoteKeeper.Quote({
            vault: vm.parseJsonAddress(j, ".onchain_quote.message.vault"),
            feed: vm.parseJsonAddress(j, ".onchain_quote.message.feed"),
            roundId: uint80(vm.parseUint(vm.parseJsonString(j, ".onchain_quote.message.roundId"))),
            spot: vm.parseUint(vm.parseJsonString(j, ".onchain_quote.message.spot")),
            strike: vm.parseUint(vm.parseJsonString(j, ".onchain_quote.message.strike")),
            premiumBps: uint32(vm.parseJsonUint(j, ".onchain_quote.message.premiumBps")),
            saleWindow: uint64(vm.parseJsonUint(j, ".onchain_quote.message.saleWindow")),
            expiry: uint64(vm.parseJsonUint(j, ".onchain_quote.message.expiry")),
            validUntil: uint64(vm.parseJsonUint(j, ".onchain_quote.message.validUntil"))
        });
        bytes memory sig = vm.parseJsonBytes(j, ".onchain_quote.signature");
        uint256 quoteBlock = vm.parseJsonUint(j, ".chain.block_number");

        vm.createSelectFork(_rpc(), quoteBlock);
        assertEq(block.timestamp, vm.parseJsonUint(j, ".chain.block_timestamp"), "fork is at the quote's block");
        assertEq(VAULT.keeper(), VAULT.owner(), "today the keeper is the owner's wallet");
        (KerneQuoteKeeper k, address owner) = _prepare(AGENT_SIGNER);
        assertEq(k.digestOf(q), vm.parseJsonBytes32(j, ".onchain_quote.digest"), "contract digest equals the agent's digest");
        console2.log("quote block", quoteBlock, "spot", q.spot);
        console2.log("strike", q.strike, "premium bps", q.premiumBps);

        // 1. Nobody but the operator can use a quote.
        vm.prank(stranger);
        vm.expectRevert(KerneQuoteKeeper.NotOperator.selector);
        k.openFromQuote(q, sig);

        // 2. The operator cannot change the price: any edit breaks the agent's signature.
        KerneQuoteKeeper.Quote memory cheap = _copy(q);
        cheap.premiumBps = q.premiumBps - 1;
        vm.prank(owner);
        vm.expectRevert(KerneQuoteKeeper.BadSignature.selector);
        k.openFromQuote(cheap, sig);
        KerneQuoteKeeper.Quote memory low = _copy(q);
        low.strike = q.strike - 1e8;
        vm.prank(owner);
        vm.expectRevert(KerneQuoteKeeper.BadSignature.selector);
        k.openFromQuote(low, sig);

        // 3. A quote priced on an older feed round is refused once the feed moves.
        uint256 snap = vm.snapshotState();
        vm.mockCall(
            TSLA_FEED,
            abi.encodeWithSelector(IFeed.latestRoundData.selector),
            abi.encode(q.roundId + 1, int256(q.spot + 2e8), block.timestamp, block.timestamp, q.roundId + 1)
        );
        vm.prank(owner);
        vm.expectRevert(KerneQuoteKeeper.QuoteStale.selector);
        k.openFromQuote(q, sig);
        vm.clearMockedCalls();
        vm.revertToState(snap);

        // 4. An expired quote is refused.
        snap = vm.snapshotState();
        vm.warp(uint256(q.validUntil) + 1);
        vm.prank(owner);
        vm.expectRevert(KerneQuoteKeeper.QuoteExpired.selector);
        k.openFromQuote(q, sig);
        vm.revertToState(snap);

        // 5. With the keeper role moved to the reference contract, the owner's wallet can no
        //    longer open an epoch at a hand-picked price.
        vm.prank(owner);
        vm.expectRevert(bytes4(keccak256("NotKeeper()")));
        VAULT.openEpoch(q.strike, 10, block.timestamp + 1 hours, q.expiry);

        // 6. The live agent's quote opens the epoch at exactly the quoted terms.
        vm.prank(owner);
        uint256 id = k.openFromQuote(q, sig);
        _assertOpened(q, id, block.timestamp);
        console2.log("epoch opened from the live agent's quote, id", id);

        // 7. The same quote cannot be used twice.
        vm.prank(owner);
        vm.expectRevert(KerneQuoteKeeper.QuoteUsed.selector);
        k.openFromQuote(q, sig);

        // 8. A buyer pays exactly the quoted premium (only while the feed price is under 4h old,
        //    which is the vault's own rule for sales).
        (,,, uint256 updatedAt,) = IFeed(TSLA_FEED).latestRoundData();
        if (block.timestamp - updatedAt <= 4 hours) {
            vm.prank(buyer);
            uint256 paid = VAULT.buyCall(10e8, type(uint256).max);
            assertEq(paid, (10e8 * uint256(q.premiumBps) + 9999) / 10000, "premium paid = notional * quoted bps");
            console2.log("buyer paid premium (stock units, 8 dp)", paid);
        } else {
            console2.log("feed price older than 4h at this block: sale step skipped, as the vault would refuse it");
        }
    }

    /// Same mechanics at the latest block with a test key, so the test still runs when the public
    /// RPC no longer serves the fixture's block. Skips itself when the vault has a live epoch or the
    /// feed is paused (weekends).
    function test_latestBlock_openFromSelfSignedQuote() public {
        if (!vm.envOr("FORK_TESTS", false)) return;
        vm.createSelectFork(_rpc());
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = IFeed(TSLA_FEED).latestRoundData();
        if (VAULT.epochLive() || block.timestamp - updatedAt > VAULT.maxStaleness()) {
            console2.log("skipped: the vault has a live epoch or the feed is paused at the latest block");
            return;
        }
        (address testSigner, uint256 pk) = makeAddrAndKey("test quote signer");
        (KerneQuoteKeeper k, address owner) = _prepare(testSigner);
        uint256 spot = uint256(answer);
        KerneQuoteKeeper.Quote memory q = KerneQuoteKeeper.Quote({
            vault: address(VAULT),
            feed: TSLA_FEED,
            roundId: roundId,
            spot: spot,
            strike: ((spot * 108 / 100) / 1e8 + 1) * 1e8,
            premiumBps: 90,
            saleWindow: 1 days,
            expiry: uint64(block.timestamp + 7 days),
            validUntil: uint64(block.timestamp + 15 minutes)
        });
        bytes memory sig = _sign(k, q, pk);

        // a quote signed by any other key is refused
        (, uint256 otherPk) = makeAddrAndKey("someone else");
        bytes memory wrongSig = _sign(k, q, otherPk);
        vm.prank(owner);
        vm.expectRevert(KerneQuoteKeeper.BadSignature.selector);
        k.openFromQuote(q, wrongSig);

        // a quote for another vault is refused
        KerneQuoteKeeper.Quote memory other = _copy(q);
        other.vault = address(0xdead);
        vm.prank(owner);
        vm.expectRevert(KerneQuoteKeeper.WrongMarket.selector);
        k.openFromQuote(other, sig);

        // the vault's own floors still apply to a validly signed quote: 1% out of the money is
        // below the vault's 3% minimum, so the vault itself reverts
        KerneQuoteKeeper.Quote memory tight = _copy(q);
        tight.strike = spot * 101 / 100;
        bytes memory tightSig = _sign(k, tight, pk);
        vm.prank(owner);
        vm.expectRevert(bytes4(keccak256("StrikeTooLow()")));
        k.openFromQuote(tight, tightSig);

        vm.prank(owner);
        uint256 id = k.openFromQuote(q, sig);
        _assertOpened(q, id, block.timestamp);
        console2.log("latest block", block.number, "epoch opened from a test-signed quote, id", id);
    }
}
