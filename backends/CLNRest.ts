import stores from '../stores/Stores';
import LND from './LND';
import TransactionRequest from '../models/TransactionRequest';
import OpenChannelRequest from '../models/OpenChannelRequest';
import VersionUtils from '../utils/VersionUtils';
import Base64Utils from '../utils/Base64Utils';
import { Hash as sha256Hash } from 'fast-sha256';

export default class CLNRest extends LND {
    getHeaders = (rune: string): any => {
        return {
            Rune: rune
        };
    };

    supports = (
        minVersion: string,
        eosVersion?: string,
        minApiVersion?: string
    ) => {
        const { nodeInfo } = stores.nodeInfoStore;
        const { version, api_version } = nodeInfo;
        const { isSupportedVersion } = VersionUtils;
        if (minApiVersion) {
            return (
                isSupportedVersion(version, minVersion, eosVersion) &&
                isSupportedVersion(api_version, minApiVersion)
            );
        }
        return isSupportedVersion(version, minVersion, eosVersion);
    };

    getTransactions = () =>
        Promise.all([
            this.postRequest('/v1/bkpr-listaccountevents', { account: 'wallet' }),
            this.postRequest('/v1/getinfo')
        ]).then(([transactions, getinfo ]) => {
            const formattedTxs: any[] = [];

            transactions.events.map((tx: any) => {
                let amount = 0;
                let txid;

                if (tx.tag === 'deposit') {
                    amount = tx.credit_msat
                    txid = tx.outpoint.split(":")[0]
                } else if ( tx.tag === 'withdrawal' ) {
                    amount = -Math.abs(tx.debit_msat)
                    txid = tx.txid
                }

                formattedTxs.push({
                    amount: amount / 1000,
                    block_height: tx.blockheight,
                    num_confirmations: getinfo.blockheight - tx.blockheight,
                    time_stamp: tx.timestamp,
                    txid: txid
                });
            });

            return {
                transactions: formattedTxs
            };
        });

    getChannels = () =>
        this.postRequest('/v1/listpeers').then((data: any) => {
            const formattedChannels: any[] = [];
            data.peers
                .filter((peer: any) => peer.channels.length)
                .map((peer: any) => {
                    peer.channels.forEach((channel: any) => {
                        if (
                            channel.state === 'ONCHAIN' ||
                            channel.state === 'CLOSED' ||
                            channel.state === 'CHANNELD_AWAITING_LOCKIN'
                        )
                            return;

                        // CLN v23.05 msat deprecations
                        const to_us_msat = parseInt(channel.to_us_msat) || 0;
                        const total_msat = parseInt(channel.total_msat) || 0;
                        const out_fulfilled_msat =
                            parseInt(channel.out_fulfilled_msat) || 0;
                        const in_fulfilled_msat =
                            parseInt(channel.in_fulfilled_msat) || 0;
                        const our_reserve_msat =
                            parseInt(channel.our_reserve_msat) || 0;
                        const their_reserve_msat =
                            parseInt(channel.their_reserve_msat) || 0;

                        formattedChannels.push({
                            active: peer.connected,
                            remote_pubkey: peer.id,
                            channel_point: channel.funding_txid,
                            chan_id: channel.channel_id,
                            alias: peer.alias,
                            capacity: Number(total_msat / 1000).toString(),
                            local_balance: Number(to_us_msat / 1000).toString(),
                            remote_balance: Number(
                                (total_msat - to_us_msat) / 1000
                            ).toString(),
                            total_satoshis_sent: Number(
                                out_fulfilled_msat / 1000
                            ).toString(),
                            total_satoshis_received: Number(
                                in_fulfilled_msat / 1000
                            ).toString(),
                            num_updates: (
                                channel.in_payments_offered +
                                channel.out_payments_offered
                            ).toString(),
                            csv_delay: channel.our_to_self_delay,
                            private: channel.private,
                            local_chan_reserve_sat: Number(
                                our_reserve_msat / 1000
                            ).toString(),
                            remote_chan_reserve_sat: Number(
                                their_reserve_msat / 1000
                            ).toString(),
                            close_address: channel.close_to_addr
                        });
                    });
                });

            return {
                channels: formattedChannels
            };
        });
    getBlockchainBalance = () =>
        this.postRequest('/v1/listfunds').then((body: any) => {
            // Onchain Balance Calculation
            let onchainBalance = {
                totalBalance: 0,
                confBalance: 0,
                unconfBalance: 0
            };
            body.outputs.forEach((output: any) => {
                if (output.status === 'confirmed') {
                    onchainBalance.confBalance =
                        onchainBalance.confBalance +
                        parseInt(output.amount_msat);
                } else if (output.status === 'unconfirmed') {
                    onchainBalance.unconfBalance =
                        onchainBalance.unconfBalance +
                        parseInt(output.amount_msat);
                }
            });
            return {
                total_balance: onchainBalance.confBalance / 1000,
                confirmed_balance:
                    (onchainBalance.confBalance -
                        onchainBalance.unconfBalance) /
                    1000,
                unconfirmed_balance: onchainBalance.unconfBalance / 1000
            };
        });
    getLightningBalance = () =>
        this.postRequest('/v1/listfunds').then((body: any) => {
            // Local Remote Balance Calculation
            let lrBalance = { localBalance: 0, pendingBalance: 0 };
            body.channels.forEach((channel: any) => {
                if (
                    channel.state === 'CHANNELD_NORMAL' &&
                    channel.connected === true
                ) {
                    lrBalance.localBalance =
                        lrBalance.localBalance +
                        parseInt(channel.our_amount_msat);
                } else if (
                    channel.state === 'CHANNELD_AWAITING_LOCKIN' ||
                    channel.state === 'DUALOPEND_AWAITING_LOCKIN'
                ) {
                    lrBalance.pendingBalance =
                        lrBalance.pendingBalance +
                        parseInt(channel.our_amount_msat);
                }
            });
            return {
                balance: lrBalance.localBalance / 1000,
                pending_open_balance: lrBalance.pendingBalance / 1000
            };
        });
    sendCoins = (data: TransactionRequest) => {
        let request: any;
        if (data.utxos) {
            request = {
                destination: data.addr,
                feerate: `${Number(data.sat_per_vbyte) * 1000}perkb`,
                satoshi: data.amount,
                utxos: data.utxos
            };
        } else {
            request = {
                destination: data.addr,
                feerate: `${Number(data.sat_per_vbyte) * 1000}perkb`,
                satoshi: data.amount
            };
        }
        return this.postRequest('/v1/withdraw', request);
    };
    getMyNodeInfo = () => this.postRequest('/v1/getinfo');
    getInvoices = () => this.postRequest('/v1/listinvoices');
    createInvoice = (data: any) =>
        this.postRequest('/v1/invoice', {
            description: data.memo,
            label: 'zeus.' + Math.random() * 1000000,
            amount_msat: Number(data.value) * 1000 || 'any',
            expiry: Number(data.expiry),
            exposeprivatechannels: false
        });
    getPayments = () =>
        this.postRequest('/v1/listpays').then((data: any) => ({
            payments: data.pays
        }));
    getNewAddress = () =>
        this.postRequest('/v1/newaddr', { addresstype: 'bech32' }).then(
            (data: any) => ({
                address: data.bech32
            })
        );
    openChannel = (data: OpenChannelRequest) => {
        let request: any;
        if (data.utxos && data.utxos.length > 0) {
            request = {
                id: data.id,
                amount: data.satoshis,
                feerate: data.sat_per_vbyte,
                announce: !data.privateChannel ? true : false,
                minconf: data.min_confs,
                utxos: data.utxos
            };
        } else {
            request = {
                id: data.id,
                amount: data.satoshis,
                feerate: data.sat_per_vbyte,
                announce: !data.privateChannel ? true : false,
                minconf: data.min_confs
            };
        }

        return this.postRequest('/v1/fundchannel', request);
    };
    connectPeer = (data: any) => {
        let [host, port] = data.addr.host.split(':');
        return this.postRequest('/v1/connect', {
            id: data.addr.pubkey,
            host: host,
            port: port
        });
    };

    decodePaymentRequest = (urlParams?: Array<string>) =>
        this.postRequest('/v1/decodepay', {
            bolt11: urlParams && urlParams[0]
        });
    payLightningInvoice = (data: any) =>
        this.postRequest('/v1/pay', {
            bolt11: data.payment_request,
            amount_msat: Number(data.amt && data.amt * 1000),
            maxfeepercent: data.max_fee_percent
        });
    sendKeysend = (data: any) =>
        this.postRequest('/v1/keysend', {
            destination: data.pubkey,
            amount_msat: Number(data.amt && data.amt * 1000)
        });
    closeChannel = (urlParams?: Array<string>) =>
        this.postRequest('/v1/close', {
            id: urlParams[0],
            unilateraltimeout: urlParams[2] ? 172800 : 0
        });
    getNodeInfo = () => this.postRequest('N/A');
    getFees = () =>
        this.postRequest('/v1/getinfo').then(
            ({ fees_collected_msat }: any) => ({
                total_fee_sum: fees_collected_msat / 1000
            })
        );
    setFees = (data: any) =>
        this.postRequest('/v1/setchannel', {
            id: data.global ? 'all' : data.channelId,
            feebase: data.base_fee_msat,
            feeppm: data.fee_rate
        });
    getRoutes = () => this.postRequest('N/A');
    getUTXOs = () => this.postRequest('/v1/listfunds');
    signMessage = (message: string) =>
        this.postRequest('/v1/signmessage', {
            message: message
        });
    verifyMessage = (data: any) =>
        this.postRequest('/v1/checkmessage', {
            message: data.msg,
            zbase: data.signature
        });
    lnurlAuth = async (r_hash: string) => {
        const signed = await this.signMessage(r_hash);
        return {
            signature: new sha256Hash()
                .update(Base64Utils.stringToUint8Array(signed.signature))
                .digest()
        };
    };

    supportsMessageSigning = () => true;
    supportsLnurlAuth = () => true;
    supportsOnchainSends = () => true;
    supportsOnchainReceiving = () => true;
    supportsKeysend = () => true;
    supportsChannelManagement = () => true;
    supportsPendingChannels = () => false;
    supportsMPP = () => false;
    supportsAMP = () => false;
    supportsCoinControl = () => this.supports('v0.8.2', undefined, 'v0.4.0');
    supportsChannelCoinControl = () =>
        this.supports('v0.8.2', undefined, 'v0.4.0');
    supportsHopPicking = () => false;
    supportsAccounts = () => false;
    supportsRouting = () => true;
    supportsNodeInfo = () => true;
    singleFeesEarnedTotal = () => true;
    supportsAddressTypeSelection = () => false;
    supportsTaproot = () => false;
    supportsBumpFee = () => false;
    supportsLSPs = () => false;
    supportsNetworkInfo = () => false;
    supportsSimpleTaprootChannels = () => false;
    supportsCustomPreimages = () => false;
    supportsSweep = () => true;
    isLNDBased = () => false;
}
