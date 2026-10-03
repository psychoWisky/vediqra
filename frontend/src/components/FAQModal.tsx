import React from 'react';
import { Modal } from './ui/Modal';
import SupportContact from './SupportContact';

interface FAQModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Only statements that are true of how the store works today. Shipping times, return terms and support hours
// are business decisions and are NOT stated here until VEDIQRA confirms them.
const FAQS: { q: string; a: string }[] = [
  { q: 'How do I place an order?', a: 'Add products to your cart, open the cart and choose Checkout. Enter your delivery details, pick a payment method and place the order.' },
  { q: 'Which payment methods are available?', a: 'You can pay online at checkout or choose cash on delivery. Any cash-on-delivery fee is shown in your order summary before you place the order.' },
  { q: 'What do shipping and other charges cost?', a: 'Shipping and any fees are calculated for your cart and shown in the order summary at checkout, before you pay.' },
  { q: 'How do I personalise a product?', a: 'Products with the Personalisable label let you add your own text and images before adding to the cart.' },
  { q: 'What are combos and custom combos?', a: 'A combo is a set of products sold together at one price. With a custom combo you choose the products yourself, and the discount grows with the number of items.' },
  { q: 'How can I track my order?', a: 'Open Track Order and enter your order number and the phone number you used at checkout.' },
];

const FAQModal: React.FC<FAQModalProps> = ({ isOpen, onClose }) => (
  <Modal isOpen={isOpen} onClose={onClose} title="Frequently asked questions">
    <div className="divide-y divide-brand-line">
      {FAQS.map((f) => (
        <details key={f.q} className="group py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-1 font-semibold [&::-webkit-details-marker]:hidden">
            {f.q}
            <span aria-hidden="true" className="text-xl leading-none text-brand-muted transition-transform group-open:rotate-45">+</span>
          </summary>
          <p className="pb-2 pt-1 text-sm text-brand-muted">{f.a}</p>
        </details>
      ))}
    </div>
    <div className="mt-6 rounded-xl bg-brand-subtle p-5">
      <p className="mb-3 font-semibold">Still have questions?</p>
      <SupportContact />
    </div>
  </Modal>
);

export default FAQModal;
