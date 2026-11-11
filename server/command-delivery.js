'use strict';

// A repeat is safe only when Bot knows it never sent the command. A timeout, an
// in-flight id and a lost reply cannot prove that the machine did nothing.
function withDelivery(result) {
    const delivery = result.result === 'ack' || result.result === 'nack' ? 'delivered'
        : result.result === 'refused' && result.code !== 'bot.command_pending' ? 'not_delivered'
            : 'uncertain';
    return {
        ...result,
        delivery,
        retry: { safe: delivery === 'not_delivered', reason: delivery === 'not_delivered'
            ? 'Bot refused the command before sending it' : delivery === 'uncertain'
                ? 'The machine may already have run this command' : 'The machine already answered this command' },
    };
}

module.exports = { withDelivery };
