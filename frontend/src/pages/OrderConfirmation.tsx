import { useEffect, useState } from 'react'
import { 
  CheckCircle, 
  Package, 
  Truck, 
  Home, 
  ShoppingBag, 
  Gift, 
  Clock,
  MapPin,
  Mail,
  Phone,
  CreditCard,
  Download,
  Share2,
  Calendar,
  Copy,
  FileText,
  Ruler,
  Palette
} from 'lucide-react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { apiFetch } from '../utils/api'
import { formatCurrency } from '../utils/helpers'
import { BRAND } from '../config/brand'
import OrderItems from '../components/OrderItems'
import SupportContact from '../components/SupportContact'
import { Spinner, ErrorState } from '../components/ui/States'
import { ButtonLink } from '../components/ui/Button'
import { formatCurrency as money } from '../utils/money'
import { friendlyError } from '../utils/errors'

interface Order {
  id: string
  custom_order_id?: string
  customer_name: string
  customer_email: string
  customer_phone?: string
  items: any[]
  total_amount: number
  payment_method?: string
  shipping_address?: string
  shipping_city?: string
  shipping_state?: string
  shipping_pincode?: string
  tracking_number?: string
  created_at?: string
  status?: string
  special_requests?: string
}

// Orders store the complete address in shipping_address ("street, city, state - pincode"); older orders may hold the street only.
const fullAddress = (o: { shipping_address?: string; shipping_city?: string; shipping_state?: string; shipping_pincode?: string }): string => {
  const street = o.shipping_address || '';
  if (o.shipping_pincode && street.includes(o.shipping_pincode)) return street;
  return [street, o.shipping_city, o.shipping_state, o.shipping_pincode].filter(Boolean).join(', ');
};

export default function OrderConfirmation() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [copySuccess, setCopySuccess] = useState(false)

  const orderId = searchParams.get('orderId')

  useEffect(() => {
    if (orderId) {
      fetchOrder()
    } else {
      navigate('/')
    }
  }, [orderId])

  const fetchOrder = async () => {
    try {
      setLoading(true)
      const response = await apiFetch(`/api/orders/confirmation/${orderId}`, {
        method: 'GET',
      })

      setOrder(response)
      
    } catch (error: any) {
      // 404 = this order does not exist; anything else = we could not load it (retry makes sense)
      setFailed(error?.status !== 404)
    } finally {
      setLoading(false)
    }
  }

  const getDisplayOrderId = () => {
    if (!order) return `${BRAND.name}#000`
    return order.custom_order_id || `${BRAND.name}#${order.id.slice(-5).toUpperCase()}`
  }

  const handleCopyOrderId = () => {
    if (order) {
      navigator.clipboard.writeText(getDisplayOrderId())
      setCopySuccess(true)
      setTimeout(() => setCopySuccess(false), 2000)
    }
  }

  // Helper function to get variant display
  const getVariantDisplay = (item: any) => {
    const parts = []
    if (item.color_name) {
      parts.push(item.color_name)
    }
    if (item.size_name) {
      parts.push(`${item.size_name}${item.size_code ? ` (${item.size_code})` : ''}`)
    }
    return parts.length > 0 ? ` - ${parts.join(', ')}` : ''
  }

  const generatePDF = async () => {
    if (!order) return

    // Loaded on demand: jsPDF + jspdf-autotable are only needed for this one action, so they're kept
    // out of the main OrderConfirmation bundle rather than loaded for every visitor who lands here.
    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ])

    const doc = new jsPDF()
    const displayOrderId = getDisplayOrderId()
    const pageWidth = doc.internal.pageSize.getWidth()
    
    // Header
    doc.setFontSize(28)
    doc.setTextColor(212, 175, 55)
    doc.setFont('helvetica', 'bold')
    doc.text(BRAND.name, 20, 25)
    
    doc.setFontSize(10)
    doc.setTextColor(100, 100, 100)
    doc.setFont('helvetica', 'normal')
    doc.text('Premium Gifts', 20, 32)
    
    // Invoice Title
    doc.setFontSize(20)
    doc.setTextColor(128, 0, 32)
    doc.setFont('helvetica', 'bold')
    doc.text('ORDER INVOICE', pageWidth - 20, 25, { align: 'right' })
    
    // Order Details
    doc.setFillColor(250, 250, 250)
    doc.roundedRect(20, 50, pageWidth - 40, 35, 3, 3, 'F')
    
    doc.setFontSize(10)
    doc.setTextColor(80, 80, 80)
    doc.setFont('helvetica', 'normal')
    doc.text('Order Number:', 25, 62)
    doc.text('Order Date:', 25, 72)
    doc.text('Payment Method:', 25, 82)
    
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(0, 0, 0)
    doc.text(displayOrderId, 65, 62)
    doc.text(order.created_at ? new Date(order.created_at).toLocaleDateString('en-IN', { 
      day: 'numeric', 
      month: 'long', 
      year: 'numeric'
    }) : new Date().toLocaleDateString(), 65, 72)
    doc.text((order.payment_method || 'Online').toUpperCase(), 65, 82)
    
    // Customer Information
    doc.setFontSize(14)
    doc.setTextColor(128, 0, 32)
    doc.setFont('helvetica', 'bold')
    doc.text('Customer Information', 20, 105)
    
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(80, 80, 80)
    doc.text('Name:', 20, 115)
    doc.text('Email:', 20, 122)
    doc.text('Phone:', 20, 129)
    
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(0, 0, 0)
    doc.text(order.customer_name, 45, 115)
    doc.text(order.customer_email, 45, 122)
    doc.text(order.customer_phone || 'N/A', 45, 129)
    
    // Shipping Address
    doc.setFontSize(14)
    doc.setTextColor(128, 0, 32)
    doc.setFont('helvetica', 'bold')
    doc.text('Shipping Address', pageWidth / 2 + 10, 105)
    
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(0, 0, 0)
    
    const address = fullAddress(order) || 'Address not provided'
    const addressLines = doc.splitTextToSize(address, pageWidth / 2 - 30)
    doc.text(addressLines, pageWidth / 2 + 10, 115)
    
    // Order Items Table
    doc.setFontSize(14)
    doc.setTextColor(128, 0, 32)
    doc.setFont('helvetica', 'bold')
    doc.text('Order Summary', 20, 155)
    
    const tableColumn = ["Item", "Variant", "Qty", "Unit Price", "Total"]
    const tableRows: any[] = []
    
    if (Array.isArray(order.items)) {
      order.items.forEach((item: any) => {
        // Handle combo items
        if (item.type === 'combo' && item.combo_products) {
          item.combo_products.forEach((cp: any) => {
            const variantText = []
            if (cp.color_name) variantText.push(cp.color_name)
            if (cp.size_name) variantText.push(cp.size_name)
            
            tableRows.push([
              `↳ ${cp.name}`,
              variantText.join(', ') || '-',
              cp.quantity.toString(),
              `₹${cp.price.toLocaleString()}`,
              `₹${(cp.price * cp.quantity).toLocaleString()}`
            ])
          })
          
          // Add combo total row
          tableRows.push([
            'COMBO TOTAL',
            item.combo_name || 'Custom Combo',
            '-',
            '-',
            `₹${item.price.toLocaleString()}`
          ])
        } else {
          // Regular item
          const variantText = []
          if (item.color_name) variantText.push(`Color: ${item.color_name}`)
          if (item.size_name) variantText.push(`Size: ${item.size_name}${item.size_code ? ` (${item.size_code})` : ''}`)
          
          tableRows.push([
            item.name,
            variantText.join(', ') || '-',
            item.quantity.toString(),
            `₹${item.price.toLocaleString()}`,
            `₹${(item.price * item.quantity).toLocaleString()}`
          ])
        }
      })
    }
    
    // Use autoTable correctly
    autoTable(doc, {
      startY: 160,
      head: [tableColumn],
      body: tableRows,
      theme: 'grid',
      headStyles: {
        fillColor: [128, 0, 32],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      alternateRowStyles: {
        fillColor: [245, 245, 250],
      },
      columnStyles: {
        0: { cellWidth: 70 },
        1: { cellWidth: 40 },
        2: { cellWidth: 20, halign: 'center' },
        3: { cellWidth: 30, halign: 'right' },
        4: { cellWidth: 30, halign: 'right' },
      },
      margin: { left: 20, right: 20 },
    })
    
    // Get the last Y position
    const finalY = (doc as any).lastAutoTable.finalY + 10
    
    // Total Amount
    doc.setFillColor(250, 250, 250)
    doc.roundedRect(pageWidth - 80, finalY, 60, 20, 3, 3, 'F')
    
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(80, 80, 80)
    doc.text('Total Amount:', pageWidth - 75, finalY + 8)
    
    doc.setFontSize(12)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(212, 175, 55)
    doc.text(`₹${order.total_amount.toLocaleString()}`, pageWidth - 25, finalY + 13, { align: 'right' })
    
    // Contact information (only what is configured)
    doc.setFontSize(9)
    doc.setTextColor(150, 150, 150)
    doc.setFont('helvetica', 'normal')
    doc.text(BRAND.name, pageWidth / 2, finalY + 40, { align: 'center' })
    const contactLine = [BRAND.supportEmail, BRAND.supportPhone].filter(Boolean).join(' | ')
    if (contactLine) doc.text(contactLine, pageWidth / 2, finalY + 45, { align: 'center' })
    
    doc.save(`${BRAND.name}_Invoice_${displayOrderId.replace('#', '_')}.pdf`)
  }

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `My ${BRAND.name} order`,
          text: `Just ordered from ${BRAND.name}! Order #${getDisplayOrderId()}`,
          url: window.location.href,
        })
      } catch (error) {
        console.log('Error sharing:', error)
      }
    }
  }

  if (loading) return <div className="container-page section"><Spinner label="Loading your order" /></div>

  if (!order) {
    return (
      <div className="container-page section">
        <ErrorState
          title={failed ? 'We could not load your order' : 'Order not found'}
          description={failed ? 'Please check your connection and try again. If you have just placed an order, it has not been lost.' : 'This order does not exist or the link is not valid.'}
          action={<div className="flex flex-wrap justify-center gap-3">{failed && <button type="button" className="btn-primary" onClick={fetchOrder}>Try again</button>}<ButtonLink to="/track-order" variant="secondary">Track an order</ButtonLink><ButtonLink to="/products" variant="secondary">Continue shopping</ButtonLink></div>}
        />
      </div>
    )
  }

  const displayOrderId = getDisplayOrderId()
  const paidOnline = order.payment_method && order.payment_method !== 'cod'
  const address = fullAddress(order)

  return (
    <div className="container-page py-8 md:py-12">
      <div className="mx-auto max-w-3xl">
        <div className="text-center" role="status">
          <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-50 text-brand-success" aria-hidden="true"><CheckCircle className="h-9 w-9" /></span>
          <h1 className="text-3xl font-extrabold sm:text-4xl">Thank you, your order is placed</h1>
          <p className="mt-2 text-brand-muted">We have received your order{order.customer_name ? `, ${order.customer_name.split(' ')[0]}` : ''}. A confirmation is sent to {order.customer_email || 'your email'}.</p>
        </div>

        <div className="card mt-8 p-5 text-center" data-testid="order-number">
          <p className="text-sm text-brand-muted">Order number</p>
          <p className="mt-1 flex items-center justify-center gap-2 text-2xl font-extrabold tracking-wide">
            <span className="font-semibold" data-testid="order-number-value">{displayOrderId}</span>
            <button type="button" onClick={handleCopyOrderId} aria-label="Copy order number" className="btn-ghost btn-sm !px-2"><Copy className="h-4 w-4" aria-hidden="true" /></button>
          </p>
          <p className="mt-1 text-sm text-brand-muted" aria-live="polite">{copySuccess ? 'Copied to clipboard' : 'Keep this number. With your mobile number it lets you track this order.'}</p>
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            <Link to="/track-order" className="btn-primary">Track your order</Link>
            <Link to="/products" className="btn-secondary">Continue shopping</Link>
          </div>
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-5">
          <section className="card p-5 md:col-span-3" aria-labelledby="oc-items">
            <h2 id="oc-items" className="text-lg font-bold">Your items</h2>
            <OrderItems items={order.items} />
            <dl className="mt-2 space-y-2 border-t border-brand-line pt-4 text-sm">
              <div className="flex justify-between text-lg font-bold"><dt>Total</dt><dd data-testid="order-total">{money(order.total_amount)}</dd></div>
              <div className="flex justify-between text-brand-muted"><dt>Payment</dt><dd>{order.payment_method === 'cod' ? 'Cash on delivery' : paidOnline ? 'Paid online' : '—'}</dd></div>
            </dl>
          </section>

          <section className="card p-5 md:col-span-2" aria-labelledby="oc-delivery">
            <h2 id="oc-delivery" className="text-lg font-bold">Delivery</h2>
            <div className="mt-3 space-y-3 text-sm">
              <p className="flex gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand-muted" aria-hidden="true" /><span><span className="block font-semibold">{order.customer_name}</span>{address}</span></p>
              {order.customer_phone && <p className="flex gap-2"><Phone className="mt-0.5 h-4 w-4 shrink-0 text-brand-muted" aria-hidden="true" />{order.customer_phone}</p>}
              {order.customer_email && <p className="flex gap-2 break-all"><Mail className="mt-0.5 h-4 w-4 shrink-0 text-brand-muted" aria-hidden="true" />{order.customer_email}</p>}
              {order.special_requests && <p className="rounded-lg bg-brand-subtle p-3 text-brand-muted"><span className="font-medium text-brand-ink">Your notes:</span> {order.special_requests}</p>}
              <p className="text-brand-muted">Status: <span className="font-semibold capitalize text-brand-ink">{(order.status || 'pending').replace('_', ' ')}</span></p>
              <p className="text-xs text-brand-muted">Delivery timing is confirmed by the store. Use Track your order to follow progress.</p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={generatePDF} className="btn-secondary btn-sm"><Download className="h-4 w-4" aria-hidden="true" /> Download invoice</button>
              {typeof navigator !== 'undefined' && 'share' in navigator && <button type="button" onClick={handleShare} className="btn-ghost btn-sm"><Share2 className="h-4 w-4" aria-hidden="true" /> Share</button>}
            </div>
          </section>
        </div>

        <section className="mt-8 text-center" aria-label="Help">
          <p className="mb-2 text-sm font-semibold">Need help with this order?</p>
          <div className="mx-auto inline-block text-left"><SupportContact /></div>
        </section>
      </div>
    </div>
  )
}
