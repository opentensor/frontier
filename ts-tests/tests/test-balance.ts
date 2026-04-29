import { expect } from "chai";
import { step } from "mocha-steps";

import {
	GENESIS_ACCOUNT,
	GENESIS_ACCOUNT_PRIVATE_KEY,
	GENESIS_ACCOUNT_BALANCE,
	EXISTENTIAL_DEPOSIT,
	toEvmBalance,
} from "./config";
import { createAndFinalizeBlock, describeWithFrontier, customRequest } from "./util";

describeWithFrontier("Frontier RPC (Balance)", (context) => {
	const TEST_ACCOUNT = "0xdd33Af49c851553841E94066B54Fd28612522901";
	const TEST_ACCOUNT_PRIVATE_KEY = "0x4ca933bffe83185dda76e7913fc96e5c97cdb7ca1fbfcc085d6376e6f564ef71";
	const TRANSFER_VALUE = "0x200"; // 512, must be higher than ExistentialDeposit
	const GAS_PRICE = "0x3B9ACA00"; // 1000000000
	var nonce = 0;

	step("genesis balance is setup correctly", async function () {
		expect(await context.web3.eth.getBalance(GENESIS_ACCOUNT)).to.equal(GENESIS_ACCOUNT_BALANCE);
	});

	step("balance to be updated after transfer", async function () {
		await createAndFinalizeBlock(context.web3);
		this.timeout(15000);

		const tx = await context.web3.eth.accounts.signTransaction(
			{
				from: GENESIS_ACCOUNT,
				to: TEST_ACCOUNT,
				value: toEvmBalance(TRANSFER_VALUE),
				gasPrice: GAS_PRICE,
				gas: "0x100000",
				nonce: nonce,
			},
			GENESIS_ACCOUNT_PRIVATE_KEY
		);
		await customRequest(context.web3, "eth_sendRawTransaction", [tx.rawTransaction]);

		await createAndFinalizeBlock(context.web3);

		// Priority fees are disabled in the runner, so a legacy tx is charged
		// gasUsed * BaseFeePerGas instead of gasUsed * gasPrice.
		// pallet_ethereum stores baseFeePerGas after on_finalize runs, so the
		// value the runner read during block N+1 is reported on block N (the
		// parent), not on the tx-bearing block.
		// The fee is then converted to substrate balance, which truncates
		// anything below 10^9 wei.
		const receipt = await context.web3.eth.getTransactionReceipt(tx.transactionHash);
		const txBlock = await context.web3.eth.getBlock(receipt.blockHash);
		const parentBlock = await context.web3.eth.getBlock(txBlock.parentHash);
		const evmGasCost = BigInt(receipt.gasUsed) * BigInt(parentBlock.baseFeePerGas);
		const substrateGranularity = BigInt(1_000_000_000);
		const gasCost = (evmGasCost / substrateGranularity) * substrateGranularity;

		const expectedGenesisBalance = (
			BigInt(GENESIS_ACCOUNT_BALANCE) -
			gasCost -
			BigInt(toEvmBalance(TRANSFER_VALUE))
		).toString();
		const expectedTestBalance = (BigInt(toEvmBalance(TRANSFER_VALUE)) - BigInt(EXISTENTIAL_DEPOSIT)).toString();

		expect(await context.web3.eth.getBalance(GENESIS_ACCOUNT)).to.equal(expectedGenesisBalance);
		expect(await context.web3.eth.getBalance(TEST_ACCOUNT)).to.equal(expectedTestBalance);
	});

	step("gas price too low", async function () {
		nonce += 1;

		let gas_price = await context.web3.eth.getGasPrice();
		const tx = await context.web3.eth.accounts.signTransaction(
			{
				from: GENESIS_ACCOUNT,
				to: TEST_ACCOUNT,
				value: TRANSFER_VALUE,
				gasPrice: Number(gas_price) - 1,
				gas: "0x100000",
				nonce: nonce,
			},
			GENESIS_ACCOUNT_PRIVATE_KEY
		);
		let result = await customRequest(context.web3, "eth_sendRawTransaction", [tx.rawTransaction]);
		expect(result.error.message).to.be.equal("gas price less than block base fee");
	});

	step("balance insufficient", async function () {
		nonce += 1;
		let test_account_balance = await context.web3.eth.getBalance(TEST_ACCOUNT);
		const tx = await context.web3.eth.accounts.signTransaction(
			{
				from: TEST_ACCOUNT,
				to: GENESIS_ACCOUNT,
				value: test_account_balance + 1,
				gasPrice: GAS_PRICE,
				gas: "0x100000",
				nonce: nonce,
			},
			TEST_ACCOUNT_PRIVATE_KEY
		);
		let result = await customRequest(context.web3, "eth_sendRawTransaction", [tx.rawTransaction]);
		expect(result.error.message).to.be.equal("insufficient funds for gas * price + value");
	});
});
