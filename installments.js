let arrays = require("./libraries/arrays.js");
let dates = require('./libraries/dates.js');
let installmentConstants = require("./constants/constants.js");
const {
  addDays
} = require("./underwriting/helpersUW.js");

function createInstallments(data) {
  arrays.polyfill();
  let installments;
  if (data.operation == installmentConstants.operationConstants.new_business) {
    switch (data.paymentScheduleName) {
      case installmentConstants.paymentScheduleConstants.full_pay:
        installments = getUpfront(data);
        break;
      case installmentConstants.paymentScheduleConstants.two_pay:
        installments = getTwoInstallments(data, installmentConstants.termConstants.semiannually, installmentConstants.numberConstants.two);
        break;
      case installmentConstants.paymentScheduleConstants.eleven_pay:
        installments = getElevenInstallments(data, installmentConstants.termConstants.month, installmentConstants.numberConstants.eleven);
        break;
      default:
        throw installmentConstants.termConstants.exception;
    }
  } else if (data.operation == installmentConstants.operationConstants.endorsement ||
    data.operation == installmentConstants.operationConstants.fee_assessment) {
    installments = getUpfront(data);
  }
  return {
    installments: installments
  };
}

function getUpfront(data) {
  let invoiceItems = data.charges.map(ch => ({
    amount: ch.amount,
    chargeId: ch.chargeId
  }));

  return [{
    dueTimestamp: data.coverageStartTimestamp,
    issueTimestamp: data.coverageStartTimestamp,
    startTimestamp: data.coverageStartTimestamp,
    endTimestamp: data.coverageEndTimestamp,
    invoiceItems: invoiceItems,
    writeOff: false
  }];
}

function getTotalPremiumEquity(data) {
  let trip_collision_premium = 0;
  let total_premium_equity = 0;
  let gross_premium = parseInt(data.policy.characteristics[data.policy.characteristics.length - 1].grossPremium);
  for (let exposure of data.policy.exposures) {
    for (let peril of exposure.perils) {
      if (peril.name == installmentConstants.perilNameConstants.trip_collision) {
        trip_collision_premium += parseInt(peril.characteristics[peril.characteristics.length - 1].premium);
      }
    }
  }
  total_premium_equity += (gross_premium - trip_collision_premium);
  return total_premium_equity;
}

function getTwoInstallments(data, increment, maxInstallments = installmentConstants.numberConstants.thousand) {
  let nowTimestamp = new Date().getTime();

  let startTimestamp = data.charges.min(c => parseInt(data.policy.originalContractStartTimestamp));
  let endTimestamp = data.charges.max(c => parseInt(data.policy.effectiveContractEndTimestamp));

  let startMoment = dates.fromTimestamp(startTimestamp, data.tenantTimeZone);
  let endMoment = dates.fromTimestamp(endTimestamp, data.tenantTimeZone);

  let installmentTimestamps = dates.span(startMoment, endMoment, increment)
    .map(m => dates.getTimestamp(m));

  if (installmentTimestamps.length == installmentConstants.numberConstants.zero)
    installmentTimestamps = [nowTimestamp];
  else if (installmentTimestamps.length > maxInstallments)
    installmentTimestamps = installmentTimestamps.slice(installmentConstants.numberConstants.zero, maxInstallments);
  let setStartTimeStamp;
  let installments = [];
  for (let i = 0; i < installmentTimestamps.length; i++) {
    let total_premium_equity = getTotalPremiumEquity(data);
    let invoice_due_amount_first = 0;
    let due_date;
    for (charge of data.charges) {
      if (charge.type == "premium" && charge.perilName != installmentConstants.perilNameConstants.trip_collision) {
        let amount = parseFloat(charge.amount);
        invoice_due_amount_first += round2(0.6 * amount);
      }
    }
    let it = installmentTimestamps[i];
    if (i == 0) {
      setStartTimeStamp = it;
      due_date = addDays(it, 7);
    } else {
      setStartTimeStamp = addDays(it, -20);
      setStartTimeStamp = new Date(setStartTimeStamp).getTime();
      let paid_equity_days_first = (invoice_due_amount_first * 365) / total_premium_equity;
      due_date = addDays(startTimestamp, paid_equity_days_first);
    }
    let dueTimestamp = new Date(due_date).getTime();
    installments.push({
      invoiceItems: [],
      dueTimestamp: dueTimestamp,
      startTimestamp: setStartTimeStamp,
      issueTimestamp: it,
      endTimestamp: i < installmentTimestamps.length - 1 ? installmentTimestamps[i + 1] : endTimestamp,
      writeOff: false
    });
  }

  for (charge of data.charges) {
    let newItems = [];
    for (let i = 0; i < installments.length; i++) {
      if (charge.coverageStartTimestamp <= installments[i].dueTimestamp &&
        charge.coverageEndTimestamp >= installments[i].dueTimestamp) {
        let newItem = {
          chargeId: charge.chargeId
        };
        newItems.push(newItem);
        installments[i].invoiceItems.push(newItem);
      }
    }
    if (newItems.length == installmentConstants.numberConstants.zero) {
      // No installments fell within the charge coverage time, so find one
      let item = {
        chargeId: charge.chargeId,
        amount: parseFloat(charge.amount)
      };
      let inst;
      for (let i = 0; i < installments.length; i++)
        if (installments[i].dueTimestamp <= charge.coverageStartTimestamp) {
          inst = installments[i];
          break;
        }
      if (inst === undefined)
        inst = installments[0];
      inst.invoiceItems.push(item);
    } else {
      let amount = parseFloat(charge.amount);
      newItems[0].amount = getTwoPayDownPayment(charge);
      newItems[1].amount = round2(amount - newItems.slice(0, 1).sum(ni => ni.amount));
    }
  }


  for (let i = 1; i < installments.length; i++) {
    installments[i].installmentFees = [{
      feeName: installmentConstants.feeConstants.two_pay_fee,
      description: "2-Pay",
      amount: 5
    }];
  }
  return installments.filter(inst => inst.invoiceItems.length > 0);
}

function getTwoPayDownPayment(charge) {

  let fraction = 0;
  if (charge.type == installmentConstants.feeConstants.fee || charge.type == installmentConstants.feeConstants.tax) {
    let amount = parseFloat(charge.amount);
    return amount;
  } else if (charge.perilName == installmentConstants.perilNameConstants.trip_collision) {
    let amount = parseFloat(charge.amount);
    return amount;
  } else {
    let amount = parseFloat(charge.amount);
    fraction = round2(0.6 * amount);
    return fraction;
  }
}

function getElevenInstallments(data, increment, maxInstallments = installmentConstants.numberConstants.thousand) {
  let nowTimestamp = new Date().getTime();

  let startTimestamp = data.charges.min(c => parseInt(data.policy.originalContractStartTimestamp));
  let endTimestamp = data.charges.max(c => parseInt(data.policy.effectiveContractEndTimestamp));

  let startMoment = dates.fromTimestamp(startTimestamp, data.tenantTimeZone);
  let endMoment = dates.fromTimestamp(endTimestamp, data.tenantTimeZone);

  let installmentTimestamps = dates.span(startMoment, endMoment, increment)
    .map(m => dates.getTimestamp(m));

  if (installmentTimestamps.length == 0)
    installmentTimestamps = [nowTimestamp];
  else if (installmentTimestamps.length > maxInstallments)
    installmentTimestamps = installmentTimestamps.slice(0, maxInstallments);

  let installments = [];
  let timestamp;
  let setStartTimeStamp;
  for (let i = 0; i < installmentTimestamps.length; i++) {
    let invoice_due_amount_first = 0,
      invoice_due_amount_second = 0;
    let due_date, amount;
    for (charge of data.charges) {
      if (charge.type == "premium" && charge.perilName != installmentConstants.perilNameConstants.trip_collision) {
        amount = parseFloat(charge.amount);
        invoice_due_amount_first += round2(0.167 * amount);
      }
      if (charge.type == "premium" && charge.perilName != installmentConstants.perilNameConstants.trip_collision) {
        invoice_due_amount_second += round2(0.0833 * amount);
      }
    }
    let total_premium_equity = getTotalPremiumEquity(data);
    let it = installmentTimestamps[i];
    if (i != 0) {
      timestamp = installmentTimestamps[i];
      setStartTimeStamp =  addDays(it, -20);
      setStartTimeStamp = new Date(setStartTimeStamp).getTime();
    }
    if (i == 0) {
      setStartTimeStamp = it;
      due_date = addDays(it, 7);
    }
    else if (i == 1) {
      let paid_equity_days_first = (invoice_due_amount_first * 365) / total_premium_equity;
      due_date = addDays(startTimestamp, paid_equity_days_first);
    } else if(i > 1){
      let paid_equity_days_second = (invoice_due_amount_second * 365) / total_premium_equity;
      due_date = addDays(timestamp, paid_equity_days_second);
    }
    let dueTimestamp = new Date(due_date).getTime();
    installments.push({
      invoiceItems: [],
      dueTimestamp: dueTimestamp,
      startTimestamp: setStartTimeStamp,
      issueTimestamp: it,
      endTimestamp: i < installmentTimestamps.length - 1 ? installmentTimestamps[i + 1] : endTimestamp,
      writeOff: false
    });
  }

  for (charge of data.charges) {
    let newItems = [];
    for (let i = 0; i < installments.length; i++) {
      if (charge.coverageStartTimestamp <= installments[i].dueTimestamp &&
        charge.coverageEndTimestamp >= installments[i].dueTimestamp) {
        let newItem = {
          chargeId: charge.chargeId
        };
        newItems.push(newItem);
        installments[i].invoiceItems.push(newItem);
      }
    }

    if (newItems.length == 0) {
      // No installments fell within the charge coverage time, so find one
      let item = {
        chargeId: charge.chargeId,
        amount: parseFloat(charge.amount)
      };
      let inst;
      for (let i = 0; i < installments.length; i++)
        if (installments[i].dueTimestamp <= charge.coverageStartTimestamp) {
          inst = installments[i];
          break;
        }
      if (inst === undefined)
        inst = installments[0];
      inst.invoiceItems.push(item);
    } else {
      let amount = parseFloat(charge.amount);
      let down_payment = getElevenPayDownPayment(charge);
      let installment = getElevenPayInstallment(charge);
      for (let i = 0; i < newItems.length; i++) {
        if (i == 0)
          newItems[i].amount = down_payment;
        else if (i > 0 && i < newItems.length - 1)
          newItems[i].amount = installment;
        else
          newItems[i].amount = round2(amount - newItems.slice(0, newItems.length - 1).sum(ni => ni.amount));

      }
    }
  }
  for (let i = 1; i < installments.length; i++) {
    installments[i].installmentFees = [{
      feeName: installmentConstants.feeConstants.eleven_pay_fee,
      description: "11-Pay",
      amount: 2
    }];
  }
  return installments.filter(inst => inst.invoiceItems.length > 0);
}

function getElevenPayDownPayment(charge) {
  let fraction = 0;
  if (charge.type == installmentConstants.feeConstants.fee || charge.type == installmentConstants.feeConstants.tax) {
    let amount = parseFloat(charge.amount);
    return amount;
  } else if (charge.perilName == installmentConstants.perilNameConstants.trip_collision) {
    let amount = parseFloat(charge.amount);
    return amount;
  } else {
    let amount = parseFloat(charge.amount);
    fraction = round2(0.167 * amount);
    return fraction;
  }
}

function getElevenPayInstallment(charge) {
  let fraction = 0;
  if (charge.type == installmentConstants.feeConstants.fee || charge.type == installmentConstants.feeConstants.tax) {
    let amount = 0;
    return amount;
  } else if (charge.perilName == installmentConstants.perilNameConstants.trip_collision) {
    let amount = 0;
    return amount;
  } else {
    let amount = parseFloat(charge.amount);
    fraction = round2(0.0833 * amount);
    return fraction;
  }
}

function round2(amount) {
  return Math.round(amount * 100.0) / 100.0;
}

exports.createInstallments = createInstallments;