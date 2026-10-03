import nodemailer from 'nodemailer';
import config from '../config';

interface OrderData {
  id: string;
  custom_order_id?: string;
  customer_email: string;
  customer_name: string;
  items: any[];
  subtotal: number;
  shipping_charge: number;
  coupon_discount: number;
  total_amount: number;
  payment_method: string;
  shipping_address: string;
  shipping_city: string;
  shipping_state: string;
  shipping_pincode: string;
  customer_phone: string;
  special_requests?: string;
  created_at: string;
  tracking_number?: string;
  status?: string;
}

interface StatusUpdateData extends OrderData {
  old_status: string;
  new_status: string;
}

interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// Create transporter with Hostinger SMTP settings
// Host/port/TLS are configurable (EMAIL_HOST, EMAIL_PORT, EMAIL_SECURE); the defaults are the previous Hostinger settings.
export const transporter = nodemailer.createTransport({
  host: config.emailHost,
  port: config.emailPort,
  secure: config.emailSecure,
  auth: {
    user: config.emailUser,
    pass: config.emailPassword
  },
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
  // Protocol-level debug logging (can include auth exchange detail) — only in development.
  debug: !config.isProduction,
});

// Startup verification only runs when credentials exist; without them it can only fail, and the
// order flows already tolerate a failed send. /smtp-test still checks SMTP on demand.
if (config.emailUser && config.emailPassword) {
  transporter.verify((error: Error | null, success?: boolean) => {
    if (error) {
      console.error('❌ SMTP connection error:', error);
    } else {
      console.log('✅ SMTP server is ready to send emails');
    }
  });
} else {
  console.log('ℹ️ SMTP not configured; startup verification skipped.');
}

// Helper function to format currency
const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(amount);
};

// Helper function to format date
const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

// Helper function to get variant display text
const getVariantText = (item: any): string => {
  const parts = [];
  if (item.color_name) {
    parts.push(`Color: ${item.color_name}`);
  }
  if (item.size_name) {
    parts.push(`Size: ${item.size_name}${item.size_code ? ` (${item.size_code})` : ''}`);
  }
  return parts.length > 0 ? `<br><span style="font-size: 12px; color: #666;">${parts.join(' • ')}</span>` : '';
};

// Helper to create items table with variants
const createItemsTable = (items: any[]): string => {
  const rows = items.map(item => {
    const variantHtml = getVariantText(item);
    return `
      <tr style="border-bottom: 1px solid #eaeaea;">
        <td style="padding: 12px 0;">
          ${item.name}
          ${variantHtml}
          ${item.type === 'combo' && item.combo_products ? `
            <div style="margin-top: 8px; padding-left: 12px; border-left: 2px solid #D4AF37;">
              <small style="color: #666;">Combo includes:</small>
              ${item.combo_products.map((cp: any) => `
                <div style="font-size: 12px; margin-top: 4px;">
                  • ${cp.name} x${cp.quantity}
                  ${cp.color_name ? ` (${cp.color_name})` : ''}
                  ${cp.size_name ? ` - Size: ${cp.size_name}` : ''}
                </div>
              `).join('')}
            </div>
          ` : ''}
        </td>
        <td style="padding: 12px 0; text-align: center;">${item.quantity}</td>
        <td style="padding: 12px 0; text-align: right;">${formatCurrency(item.price)}</td>
        <td style="padding: 12px 0; text-align: right;">${formatCurrency(item.price * item.quantity)}</td>
      </tr>
    `;
  }).join('');

  return `
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
      <thead>
        <tr style="border-bottom: 2px solid #D4AF37;">
          <th style="padding: 12px 0; text-align: left;">Item</th>
          <th style="padding: 12px 0; text-align: center;">Qty</th>
          <th style="padding: 12px 0; text-align: right;">Price</th>
          <th style="padding: 12px 0; text-align: right;">Total</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
};

// ===========================================
// SEND ORDER CONFIRMATION EMAIL (MINIMAL UI)
// ===========================================
export const sendOrderConfirmationEmail = async (orderData: OrderData): Promise<EmailResult> => {
  try {
    console.log('📧 Sending order confirmation email to:', orderData.customer_email);

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Order Confirmation</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; 
            line-height: 1.5; 
            color: #333; 
            margin: 0; 
            padding: 0;
            background-color: #f5f5f5;
          }
          .container { 
            max-width: 600px; 
            margin: 20px auto; 
            background: white; 
            border-radius: 8px; 
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
          }
          .content { 
            padding: 30px; 
          }
          h1 { 
            margin: 0 0 10px 0; 
            font-size: 24px; 
            font-weight: 500; 
            color: #D4AF37; 
          }
          h2 { 
            margin: 30px 0 15px 0; 
            font-size: 18px; 
            font-weight: 500; 
            color: #666; 
            border-bottom: 1px solid #eaeaea; 
            padding-bottom: 8px; 
          }
          .order-id { 
            background: #f8f8f8; 
            padding: 12px; 
            border-radius: 4px; 
            margin: 20px 0; 
            font-size: 14px; 
          }
          table { 
            width: 100%; 
            border-collapse: collapse; 
            margin: 15px 0; 
            font-size: 14px; 
          }
          th { 
            text-align: left; 
            padding: 10px 0; 
            border-bottom: 2px solid #D4AF37; 
            font-weight: 500; 
            color: #666; 
          }
          td { 
            padding: 10px 0; 
            border-bottom: 1px solid #eaeaea; 
          }
          .variant-badge {
            display: inline-block;
            padding: 2px 8px;
            background: #f0f0f0;
            border-radius: 12px;
            font-size: 11px;
            margin-right: 4px;
          }
          .total-row { 
            font-weight: 600; 
            font-size: 16px; 
          }
          .footer { 
            margin-top: 30px; 
            padding-top: 20px; 
            border-top: 1px solid #eaeaea; 
            text-align: center; 
            color: #999; 
            font-size: 12px; 
          }
          .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            background: ${orderData.payment_method === 'online' ? '#e6f7e6' : '#fff3e0'};
            color: ${orderData.payment_method === 'online' ? '#2e7d32' : '#b85c00'};
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="content">
            <h1>🎁 Thank You for Your Order</h1>
            <p style="color: #666;">Dear ${orderData.customer_name},</p>
            <p style="color: #666;">Your order has been confirmed and is being processed.</p>
            
            <div class="order-id">
              <span style="color: #999;">Order ID:</span> 
              <span style="font-weight: 500;">${orderData.custom_order_id || '#' + orderData.id}</span>
              <span style="float: right;" class="badge">${orderData.payment_method === 'online' ? 'Paid' : 'COD'}</span>
            </div>
            
            <h2>Order Details</h2>
            <p style="font-size: 14px; color: #666; margin: 5px 0;">Date: ${formatDate(orderData.created_at)}</p>
            
            ${createItemsTable(orderData.items)}
            
            <div style="border-top: 1px solid #eaeaea; padding-top: 15px; margin-top: 10px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                <span style="color: #666;">Subtotal:</span>
                <span>${formatCurrency(orderData.subtotal)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                <span style="color: #666;">Shipping:</span>
                <span>${orderData.shipping_charge === 0 ? 'Free' : formatCurrency(orderData.shipping_charge)}</span>
              </div>
              ${orderData.coupon_discount > 0 ? `
              <div style="display: flex; justify-content: space-between; margin-bottom: 5px; color: #2e7d32;">
                <span>Discount:</span>
                <span>-${formatCurrency(orderData.coupon_discount)}</span>
              </div>
              ` : ''}
              ${orderData.payment_method === 'cod' ? `
              <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                <span style="color: #666;">COD Charges:</span>
                <span>₹49</span>
              </div>
              ` : ''}
              <div style="display: flex; justify-content: space-between; margin-top: 10px; font-size: 16px; font-weight: 600; border-top: 2px solid #eaeaea; padding-top: 10px;">
                <span>Total:</span>
                <span style="color: #D4AF37;">${formatCurrency(orderData.total_amount)}</span>
              </div>
            </div>
            
            <h2 style="margin-top: 30px;">Shipping Address</h2>
            <p style="margin: 0; color: #666;">${orderData.customer_name}</p>
            <p style="margin: 5px 0; color: #666;">${orderData.shipping_address}</p>
            <p style="margin: 5px 0; color: #666;">${orderData.shipping_city}, ${orderData.shipping_state} - ${orderData.shipping_pincode}</p>
            <p style="margin: 5px 0; color: #666;">📞 ${orderData.customer_phone}</p>
            
            ${orderData.special_requests ? `
            <h2 style="margin-top: 30px;">Special Requests</h2>
            <p style="color: #666;">${orderData.special_requests}</p>
            ` : ''}
            
            <div style="background: #f8f8f8; padding: 15px; border-radius: 4px; margin-top: 30px;">
              <p style="margin: 0; color: #666; font-size: 14px;">
                <strong>What's Next?</strong><br>
                • We'll notify you once your order is shipped<br>
              </p>
            </div>
            
            <div class="footer">
              <p>© ${new Date().getFullYear()} ${config.brandName}. All rights reserved.</p>
              ${config.supportEmail ? `<p style="margin-top: 5px;"><a href="mailto:${config.supportEmail}" style="color: #D4AF37; text-decoration: none;">${config.supportEmail}</a></p>` : ''}
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"${config.brandName}" <${config.emailUser}>`,
      to: orderData.customer_email,
      ...(config.supportEmail ? { cc: [config.supportEmail] } : {}),
      subject: `Order Confirmed: ${orderData.custom_order_id || '#' + orderData.id}`,
      html: html
    };

    const info = await transporter.sendMail(mailOptions);
    
    console.log('✅ Email sent successfully!');
    console.log('📬 Message ID:', info.messageId);
    
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const err = error as Error;
    console.error('❌ Failed to send email:', err);
    return { success: false, error: err.message };
  }
};

// ===========================================
// SEND ADMIN NOTIFICATION (MINIMAL UI)
// ===========================================
export const sendAdminNotification = async (orderData: OrderData): Promise<EmailResult> => {
  try {
    const orderDisplayId = orderData.custom_order_id || '#' + orderData.id;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; 
            line-height: 1.5; 
            color: #333; 
            margin: 0; 
            padding: 0;
            background-color: #f5f5f5;
          }
          .container { 
            max-width: 600px; 
            margin: 20px auto; 
            background: white; 
            border-radius: 8px; 
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
          }
          .content { 
            padding: 30px; 
          }
          h1 { 
            margin: 0 0 10px 0; 
            font-size: 24px; 
            font-weight: 500; 
            color: #D4AF37; 
          }
          h2 { 
            margin: 30px 0 15px 0; 
            font-size: 18px; 
            font-weight: 500; 
            color: #666; 
            border-bottom: 1px solid #eaeaea; 
            padding-bottom: 8px; 
          }
          table { 
            width: 100%; 
            border-collapse: collapse; 
            margin: 15px 0; 
            font-size: 14px; 
          }
          th { 
            text-align: left; 
            padding: 10px 0; 
            border-bottom: 2px solid #D4AF37; 
            font-weight: 500; 
            color: #666; 
          }
          td { 
            padding: 8px 0; 
            border-bottom: 1px solid #eaeaea; 
          }
          .variant-tag {
            display: inline-block;
            padding: 2px 6px;
            background: #f0f0f0;
            border-radius: 4px;
            font-size: 10px;
            margin-left: 4px;
          }
          .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            background: ${orderData.payment_method === 'online' ? '#e6f7e6' : '#fff3e0'};
            color: ${orderData.payment_method === 'online' ? '#2e7d32' : '#b85c00'};
          }
          .footer { 
            margin-top: 30px; 
            padding-top: 20px; 
            border-top: 1px solid #eaeaea; 
            text-align: center; 
            color: #999; 
            font-size: 12px; 
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="content">
            <h1>🎁 New Order Received</h1>
            
            <div style="margin: 20px 0; display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 18px; font-weight: 500;">${orderDisplayId}</span>
              <span class="badge">${orderData.payment_method === 'online' ? 'Paid Online' : 'Cash on Delivery'}</span>
            </div>
            
            <h2>Customer Details</h2>
            <p style="margin: 5px 0;"><strong>Name:</strong> ${orderData.customer_name}</p>
            <p style="margin: 5px 0;"><strong>Email:</strong> ${orderData.customer_email}</p>
            <p style="margin: 5px 0;"><strong>Phone:</strong> ${orderData.customer_phone}</p>
            <p style="margin: 5px 0;"><strong>Order Date:</strong> ${formatDate(orderData.created_at)}</p>
            
            <h2>Shipping Address</h2>
            <p style="margin: 0;">${orderData.shipping_address}</p>
            <p style="margin: 5px 0;">${orderData.shipping_city}, ${orderData.shipping_state} - ${orderData.shipping_pincode}</p>
            
            <h2>Items Ordered</h2>
            ${createItemsTable(orderData.items)}
            
            ${orderData.special_requests ? `
            <h2>Special Requests</h2>
            <p style="color: #666;">${orderData.special_requests}</p>
            ` : ''}
            
            <div style="margin-top: 20px; padding-top: 20px; border-top: 2px solid #eaeaea;">
              <div style="display: flex; justify-content: space-between; font-size: 18px; font-weight: bold;">
                <span>Total Amount:</span>
                <span style="color: #D4AF37;">${formatCurrency(orderData.total_amount)}</span>
              </div>
            </div>
            
            <div class="footer">
              <p>This is an automated notification from ${config.brandName} Admin</p>
              <p>© ${new Date().getFullYear()} ${config.brandName}. All rights reserved.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const adminMailOptions = {
      from: `"${config.brandName} Orders" <${config.emailUser}>`,
      to: config.supportEmail || config.emailUser,
      subject: `New Order: ${orderDisplayId}`,
      html: html
    };

    const info = await transporter.sendMail(adminMailOptions);
    console.log('✅ Admin notification sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const err = error as Error;
    console.error('❌ Failed to send admin notification:', err);
    return { success: false, error: err.message };
  }
};

// ===========================================
// SEND ORDER STATUS UPDATE EMAIL (MINIMAL UI)
// ===========================================
export const sendOrderStatusUpdateEmail = async (data: StatusUpdateData): Promise<EmailResult> => {
  try {
    console.log(`📧 Sending status update email for order ${data.custom_order_id}`);

    const statusColors: Record<string, { bg: string; text: string; label: string }> = {
      'processing': { bg: '#e3f2fd', text: '#0d47a1', label: 'Processing' },
      'shipped': { bg: '#f3e5f5', text: '#4a148c', label: 'Shipped' },
      'delivered': { bg: '#e8f5e8', text: '#1b5e20', label: 'Delivered' },
      'cancelled': { bg: '#ffebee', text: '#b71c1c', label: 'Cancelled' }
    };

    const statusInfo = statusColors[data.new_status] || { 
      bg: '#fff3e0', 
      text: '#b85c00', 
      label: data.new_status 
    };

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; 
            line-height: 1.5; 
            color: #333; 
            margin: 0; 
            padding: 0;
            background-color: #f5f5f5;
          }
          .container { 
            max-width: 600px; 
            margin: 20px auto; 
            background: white; 
            border-radius: 8px; 
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
          }
          .content { 
            padding: 30px; 
          }
          h1 { 
            margin: 0 0 10px 0; 
            font-size: 24px; 
            font-weight: 500; 
            color: #D4AF37; 
          }
          h2 { 
            margin: 30px 0 15px 0; 
            font-size: 18px; 
            font-weight: 500; 
            color: #666; 
            border-bottom: 1px solid #eaeaea; 
            padding-bottom: 8px; 
          }
          .status-badge {
            display: inline-block;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: 500;
            background: ${statusInfo.bg};
            color: ${statusInfo.text};
            margin: 10px 0;
          }
          table { 
            width: 100%; 
            border-collapse: collapse; 
            margin: 15px 0; 
            font-size: 14px; 
          }
          th { 
            text-align: left; 
            padding: 10px 0; 
            border-bottom: 2px solid #D4AF37; 
            font-weight: 500; 
            color: #666; 
          }
          td { 
            padding: 8px 0; 
            border-bottom: 1px solid #eaeaea; 
          }
          .variant-info {
            font-size: 12px;
            color: #666;
            margin-top: 2px;
          }
          .footer { 
            margin-top: 30px; 
            padding-top: 20px; 
            border-top: 1px solid #eaeaea; 
            text-align: center; 
            color: #999; 
            font-size: 12px; 
          }
          .tracking-info {
            background: #f8f8f8;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="content">
            <h1>Order Status Update</h1>
            <p style="color: #666;">Dear ${data.customer_name},</p>
            
            <div style="text-align: center;">
              <span class="status-badge">${statusInfo.label}</span>
            </div>
            
            <p style="text-align: center; color: #666; margin: 20px 0;">
              Your order #${data.custom_order_id} has been updated to <strong>${data.new_status}</strong>
            </p>
            
            ${data.tracking_number ? `
            <div class="tracking-info">
              <p style="margin: 0; color: #666; font-size: 14px;">
                <strong>Tracking Number:</strong> ${data.tracking_number}
              </p>
            </div>
            ` : ''}
            
            <h2>Order Summary</h2>
            ${createItemsTable(data.items)}
            
            <div style="border-top: 1px solid #eaeaea; padding-top: 15px; margin-top: 10px;">
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #666;">Total Amount:</span>
                <span style="font-weight: 600; color: #D4AF37;">${formatCurrency(data.total_amount)}</span>
              </div>
            </div>
            
            <div class="footer">
              <p>© ${new Date().getFullYear()} ${config.brandName}. All rights reserved.</p>
              ${config.supportEmail ? `<p style="margin-top: 5px;"><a href="mailto:${config.supportEmail}" style="color: #D4AF37; text-decoration: none;">${config.supportEmail}</a></p>` : ''}
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"${config.brandName}" <${config.emailUser}>`,
      to: data.customer_email,
      subject: `Order #${data.custom_order_id} - ${data.new_status}`,
      html: html
    };

    const info = await transporter.sendMail(mailOptions);
    
    console.log(`✅ Status update email sent for order ${data.custom_order_id}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const err = error as Error;
    console.error('❌ Failed to send status update email:', err);
    return { success: false, error: err.message };
  }
};