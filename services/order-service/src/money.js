const MAX_TOTAL_CENTS = 999999999999999999n;

function toCents(value) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(value)
  ) {
    throw new Error('Gia san pham khong hop le');
  }

  const [whole, fraction = ''] = value.split('.');

  return BigInt(whole) * 100n +
    BigInt(fraction.padEnd(2, '0'));
}

function formatMoney(cents) {
  if (typeof cents !== 'bigint' || cents < 0n) {
    throw new Error('So tien khong hop le');
  }

  return `${cents / 100n}.${(cents % 100n)
    .toString()
    .padStart(2, '0')}`;
}

function calculateTotals(items, discountPercent) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Don hang phai co san pham');
  }

  if (
    !Number.isInteger(discountPercent) ||
    discountPercent < 0 ||
    discountPercent > 100
  ) {
    throw new Error('Ty le giam gia phai la so nguyen tu 0 den 100');
  }

  let subtotal = 0n;

  for (const item of items) {
    if (
      !Number.isInteger(item.qty) ||
      item.qty <= 0 ||
      item.qty > 2147483647
    ) {
      throw new Error('So luong khong hop le');
    }

    subtotal += toCents(item.unit_price) * BigInt(item.qty);
  }

  if (subtotal > MAX_TOTAL_CENTS) {
    throw new Error('Gia tri don hang vuot gioi han');
  }

  // Lam tron tien giam den 2 chu so thap phan.
  const discount =
    (subtotal * BigInt(discountPercent) + 50n) / 100n;

  return {
    subtotal: formatMoney(subtotal),
    discount: formatMoney(discount),
    total_amount: formatMoney(subtotal - discount)
  };
}

module.exports = {
  toCents,
  formatMoney,
  calculateTotals
};