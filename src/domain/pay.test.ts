import { describe, expect, test } from "bun:test";
import { convert, monthlyInView, parsePay, payPhrase, toMonthly } from "./pay";

describe("parsePay", () => {
  test("$60k–$80k/yr", () => {
    expect(parsePay("Salary: $60k–$80k/yr plus equity")).toEqual({
      min: 60000,
      max: 80000,
      currency: "USD",
      period: "year",
      phrase: "$60k–$80k/yr",
    });
  });
  test("a code before the figure and a period in words", () => {
    expect(parsePay("Pay is USD 5,000 per month.")).toEqual({
      min: 5000,
      max: null,
      currency: "USD",
      period: "month",
      phrase: "USD 5,000 per month",
    });
  });
  test("peso ranges with the k on the second figure only", () => {
    expect(parsePay("₱80 - 100k monthly")).toMatchObject({ min: 80000, max: 100000, currency: "PHP", period: "month" });
    expect(parsePay("₱80,000 to ₱100,000 a month")).toMatchObject({ min: 80000, max: 100000, period: "month" });
  });
  test("a trailing code and an hourly rate", () => {
    expect(parsePay("We pay 35-45 EUR/hour")).toMatchObject({ min: 35, max: 45, currency: "EUR", period: "hour" });
    expect(parsePay("£40 an hour")).toMatchObject({ min: 40, max: null, currency: "GBP", period: "hour" });
  });
  test("no period stays null; plain numbers without a currency are not pay", () => {
    expect(parsePay("€50,000")).toMatchObject({ min: 50000, currency: "EUR", period: null });
    expect(parsePay("5+ years and 2 weeks of onboarding")).toBeNull();
  });
});

describe("conversion", () => {
  test("periods convert to monthly at 173.33 hours, 21.67 days, 4.33 weeks", () => {
    expect(toMonthly({ amount: 10, period: "hour" })).toBeCloseTo(1733.3);
    expect(toMonthly({ amount: 100, period: "day" })).toBeCloseTo(2167);
    expect(toMonthly({ amount: 1000, period: "week" })).toBeCloseTo(4330);
    expect(toMonthly({ amount: 120000, period: "year" })).toBeCloseTo(10000);
  });
  test("convert uses the rate, keeps the view currency, and gives null with no rate", () => {
    expect(convert({ amount: 100, currency: "USD", viewCurrency: "PHP", rates: { USD: 57.8 } })).toBeCloseTo(5780);
    expect(convert({ amount: 100, currency: "PHP", viewCurrency: "PHP", rates: {} })).toBe(100);
    expect(convert({ amount: 100, currency: "EUR", viewCurrency: "PHP", rates: { USD: 57.8 } })).toBeNull();
  });
});

describe("monthlyInView", () => {
  test("$60k–$80k/yr with USD = 57.80 shows the monthly PHP range", () => {
    const pay = { min: 60000, max: 80000, currency: "USD", period: "year" as const };
    expect(monthlyInView({ pay, viewCurrency: "PHP", rates: { USD: 57.8 } })).toBe("₱289,000–₱385,333 a month");
  });
  test("compact, for a Board card: three significant digits, K and M", () => {
    const pay = { min: 60000, max: 80000, currency: "USD", period: "year" as const };
    expect(monthlyInView({ pay, viewCurrency: "PHP", rates: { USD: 57.8 }, compact: true })).toBe(
      "₱289K–₱385K a month",
    );
    const big = { min: 30000, max: null, currency: "USD", period: "month" as const };
    expect(monthlyInView({ pay: big, viewCurrency: "PHP", rates: { USD: 57.8 }, compact: true })).toBe(
      "₱1.73M a month",
    );
  });
  test("a EUR job with no rate shows as posted (no conversion)", () => {
    const pay = { min: 50000, max: null, currency: "EUR", period: "year" as const };
    expect(monthlyInView({ pay, viewCurrency: "PHP", rates: { USD: 57.8 } })).toBeNull();
  });
  test("pay with no period is shown as posted", () => {
    expect(
      monthlyInView({
        pay: { min: 1, max: null, currency: "USD", period: null },
        viewCurrency: "PHP",
        rates: { USD: 57.8 },
      }),
    ).toBeNull();
  });
  test("payPhrase words structured pay", () => {
    expect(payPhrase({ min: 60000, max: 80000, currency: "USD", period: "year" })).toBe("$60,000–$80,000 a year");
    expect(payPhrase({ min: 35, max: null, currency: "USD", period: "hour" })).toBe("$35 an hour");
  });
});
