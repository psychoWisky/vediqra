import React from 'react';
import { formatCurrency } from '../../utils/helpers';
import { Order } from '../../types';
import { BRAND } from '../../config/brand';

interface InvoicePDFProps {
  order: Order;
  onClose?: () => void;
}

const InvoicePDF: React.FC<InvoicePDFProps> = ({ order, onClose }) => {
  const invoiceDate = new Date().toLocaleDateString('en-IN', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
  const orderDate = new Date(order.created_at).toLocaleDateString('en-IN', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const subtotal = order.subtotal ?? order.total_amount;
  const shipping = order.shipping_charge ?? 0;
  const cod = order.cod_charge ?? 0;
  const couponDiscount = order.coupon_discount ?? 0;
  const grandTotal = order.grand_total ?? order.total_amount;

  const handlePrint = () => {
    const printArea = document.getElementById('invoice-print-area');
    if (!printArea) return;
    const w = window.open('', '_blank', 'width=800,height=900');
    if (!w) return;
    w.document.write(`
      <html><head><title>Invoice - ${order.custom_order_id || order.id.slice(0,8).toUpperCase()}</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a1a; padding: 24px; }
        .header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #c9a84c; padding-bottom:12px; margin-bottom:16px; }
        .brand h1 { font-size:22px; font-weight:bold; color:#c9a84c; }
        .brand p { font-size:11px; color:#666; }
        .inv-meta { text-align:right; }
        .inv-meta h2 { font-size:18px; font-weight:bold; color:#c9a84c; }
        .badge { display:inline-block; background:#d1fae5; color:#065f46; padding:2px 8px; border-radius:4px; font-size:10px; margin-top:4px; }
        .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:14px; }
        .box { background:#f9f9f9; padding:10px; border-radius:6px; }
        .box-label { font-size:10px; font-weight:bold; text-transform:uppercase; color:#888; margin-bottom:6px; }
        table { width:100%; border-collapse:collapse; margin-bottom:14px; font-size:11px; }
        th { background:#c9a84c; color:white; padding:6px 8px; text-align:left; }
        td { padding:5px 8px; border-bottom:1px solid #eee; }
        .totals { display:flex; justify-content:flex-end; }
        .totals-box { width:220px; }
        .totals-row { display:flex; justify-content:space-between; padding:3px 0; font-size:12px; color:#555; }
        .totals-green { color:#16a34a; }
        .totals-final { border-top:2px solid #c9a84c; padding-top:6px; margin-top:4px; display:flex; justify-content:space-between; font-weight:bold; font-size:14px; color:#c9a84c; }
        .footer { margin-top:16px; padding-top:10px; border-top:1px solid #eee; text-align:center; font-size:10px; color:#999; }
      </style></head><body>
      <div class="header">
        <div class="brand"><h1>${BRAND.name}</h1><p>${BRAND.tagline}</p>${[BRAND.supportEmail, BRAND.supportPhone].filter(Boolean).length ? `<p>${[BRAND.supportEmail, BRAND.supportPhone].filter(Boolean).join(' • ')}</p>` : ''}</div>
        <div class="inv-meta"><h2>INVOICE</h2><p>#${order.custom_order_id || order.id.slice(0,8).toUpperCase()}</p><p>${invoiceDate}</p><span class="badge">PAID</span></div>
      </div>
      <div class="grid2">
        <div class="box"><div class="box-label">Bill To</div><p><strong>${order.customer_name}</strong></p><p>${order.customer_email}</p>${order.customer_phone ? `<p>${order.customer_phone}</p>` : ''}<p style="margin-top:4px">${order.shipping_address || ''}</p>${order.shipping_pincode && (order.shipping_address || '').includes(order.shipping_pincode) ? '' : `<p>${order.shipping_city || ''}, ${order.shipping_state || ''} - ${order.shipping_pincode || ''}</p>`}</div>
        <div class="box"><div class="box-label">Order Info</div><p><span style="color:#888">Order Date:</span> ${orderDate}</p>${order.razorpay_payment_id ? `<p><span style="color:#888">Payment ID:</span> ${order.razorpay_payment_id.slice(0,14)}…</p>` : ''}${order.tracking_number ? `<p><span style="color:#888">Tracking #:</span> ${order.tracking_number}</p>` : ''}${order.payment_method ? `<p><span style="color:#888">Payment:</span> ${order.payment_method.toUpperCase()}</p>` : ''}</div>
      </div>
      ${printArea.querySelector('table')?.outerHTML || ''}
      <div class="totals"><div class="totals-box">
        <div class="totals-row"><span>Subtotal</span><span>${formatCurrency(subtotal)}</span></div>
        ${shipping > 0 ? `<div class="totals-row"><span>Shipping</span><span>${formatCurrency(shipping)}</span></div>` : `<div class="totals-row totals-green"><span>Shipping</span><span>FREE</span></div>`}
        ${cod > 0 ? `<div class="totals-row"><span>COD Charge</span><span>${formatCurrency(cod)}</span></div>` : ''}
        ${couponDiscount > 0 ? `<div class="totals-row totals-green"><span>Discount${order.coupon_code ? ` (${order.coupon_code})` : ''}</span><span>-${formatCurrency(couponDiscount)}</span></div>` : ''}
        <div class="totals-final"><span>Grand Total</span><span>${formatCurrency(grandTotal)}</span></div>
      </div></div>
      <div class="footer"><p><strong style="color:#333">Thank you for your order!</strong></p>${[BRAND.name, BRAND.supportEmail, BRAND.supportPhone].filter(Boolean).length ? `<p>${[BRAND.name, BRAND.supportEmail, BRAND.supportPhone].filter(Boolean).join(' • ')}</p>` : ''}<p>Computer-generated invoice — no signature required. Generated on ${invoiceDate}.</p></div>
      </body></html>
    `);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 400);
  };

  return (
    <div className="bg-white">
      {/* Action bar */}
      <div className="flex items-center justify-between p-4 border-b bg-gray-50">
        <h2 className="text-lg font-semibold text-gray-800">
          Invoice #{order.custom_order_id || order.id.slice(0,8).toUpperCase()}
        </h2>
        <div className="flex gap-2">
          <button
            onClick={handlePrint}
            className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 text-sm font-medium"
          >
            💾 Save Invoice (PDF)
          </button>
          {onClose && (
            <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-100">
              ✕ Close
            </button>
          )}
        </div>
      </div>

      {/* Preview */}
      <div id="invoice-print-area" className="p-5 max-w-3xl mx-auto text-sm">
        {/* Header */}
        <div className="flex justify-between items-start border-b-2 border-yellow-500 pb-3 mb-4">
          <div>
            <h1 className="text-xl font-bold text-yellow-600">{BRAND.name}</h1>
            <p className="text-gray-400 text-xs">{BRAND.tagline}</p>
            {(BRAND.supportEmail || BRAND.supportPhone) && (
              <p className="text-gray-400 text-xs">{[BRAND.supportEmail, BRAND.supportPhone].filter(Boolean).join(' • ')}</p>
            )}
          </div>
          <div className="text-right">
            <h2 className="text-lg font-bold text-yellow-600">INVOICE</h2>
            <p className="text-gray-500 text-xs">#{order.custom_order_id || order.id.slice(0,8).toUpperCase()}</p>
            <p className="text-gray-500 text-xs">{invoiceDate}</p>
            <span className="inline-block mt-1 px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs font-medium">PAID</span>
          </div>
        </div>

        {/* Info grid */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-gray-50 p-3 rounded-lg">
            <p className="text-xs font-bold uppercase text-gray-400 mb-1">Bill To</p>
            <p className="font-semibold text-sm">{order.customer_name}</p>
            <p className="text-gray-500 text-xs">{order.customer_email}</p>
            {order.customer_phone && <p className="text-gray-500 text-xs">{order.customer_phone}</p>}
            <p className="text-gray-500 text-xs mt-1">{order.shipping_address}</p>
            <p className="text-gray-500 text-xs">{order.shipping_city}, {order.shipping_state} - {order.shipping_pincode}</p>
          </div>
          <div className="bg-gray-50 p-3 rounded-lg">
            <p className="text-xs font-bold uppercase text-gray-400 mb-1">Order Info</p>
            <div className="space-y-0.5 text-xs">
              <div className="flex justify-between"><span className="text-gray-400">Order Date</span><span>{orderDate}</span></div>
              {order.razorpay_payment_id && (
                <div className="flex justify-between"><span className="text-gray-400">Payment ID</span><span className="font-mono">{order.razorpay_payment_id.slice(0,14)}…</span></div>
              )}
              {order.tracking_number && (
                <div className="flex justify-between"><span className="text-gray-400">Tracking #</span><span>{order.tracking_number}</span></div>
              )}
              {order.payment_method && (
                <div className="flex justify-between"><span className="text-gray-400">Method</span><span className="uppercase">{order.payment_method}</span></div>
              )}
            </div>
          </div>
        </div>

        {/* Items */}
        <table className="w-full border-collapse mb-4 text-xs">
          <thead>
            <tr className="bg-yellow-500 text-white">
              <th className="text-left p-2">Item</th>
              <th className="text-center p-2 w-12">Qty</th>
              <th className="text-right p-2 w-20">Unit Price</th>
              <th className="text-right p-2 w-20">Total</th>
            </tr>
          </thead>
          <tbody>
            {Array.isArray(order.items) ? order.items.map((item: any, i: number) => (
              <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                <td className="p-2">
                  <p className="font-medium">{item.name}</p>
                  {(item.color_name || item.size_name) && (
                    <p className="text-gray-400 text-xs">{[item.color_name, item.size_name].filter(Boolean).join(' / ')}</p>
                  )}
                  {item.customization && <p className="text-purple-500 text-xs">✦ Customized</p>}
                </td>
                <td className="p-2 text-center">{item.quantity}</td>
                <td className="p-2 text-right">{formatCurrency(item.price)}</td>
                <td className="p-2 text-right font-medium">{formatCurrency(item.price * item.quantity)}</td>
              </tr>
            )) : (
              <tr><td colSpan={4} className="p-2 text-center text-gray-400">No items</td></tr>
            )}
          </tbody>
        </table>

        {/* Totals */}
        <div className="flex justify-end mb-4">
          <div className="w-52 space-y-1 text-xs">
            <div className="flex justify-between text-gray-500"><span>Subtotal</span><span>{formatCurrency(subtotal)}</span></div>
            {shipping > 0
              ? <div className="flex justify-between text-gray-500"><span>Shipping</span><span>{formatCurrency(shipping)}</span></div>
              : <div className="flex justify-between text-green-600"><span>Shipping</span><span>FREE</span></div>
            }
            {cod > 0 && <div className="flex justify-between text-gray-500"><span>COD Charge</span><span>{formatCurrency(cod)}</span></div>}
            {couponDiscount > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Discount{order.coupon_code ? ` (${order.coupon_code})` : ''}</span>
                <span>-{formatCurrency(couponDiscount)}</span>
              </div>
            )}
            <div className="border-t-2 border-yellow-500 pt-2 flex justify-between font-bold text-sm text-yellow-700">
              <span>Grand Total</span><span>{formatCurrency(grandTotal)}</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t pt-3 text-center text-xs text-gray-400">
          <p className="font-medium text-gray-600">Thank you for your order!</p>
          <p>{[BRAND.name, BRAND.supportEmail, BRAND.supportPhone].filter(Boolean).join(' • ')}</p>
          <p>Computer-generated invoice — no signature required. Generated {invoiceDate}.</p>
        </div>
      </div>
    </div>
  );
};

export default InvoicePDF;
