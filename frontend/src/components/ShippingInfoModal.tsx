import React from 'react';
import { Modal } from './ui/Modal';
import SupportContact from './SupportContact';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const ShippingInfoModal: React.FC<Props> = ({ isOpen, onClose }) => (
  <Modal isOpen={isOpen} onClose={onClose} title="Shipping information" widthClass="max-w-lg">
    <p className="text-sm text-brand-muted">
      Shipping charges for your cart are calculated by the store and shown in the order summary at checkout, before you pay.
    </p>
    <p className="mt-3 text-sm text-brand-muted">
      Delivery timelines and coverage will be published here once confirmed. For anything urgent, please get in touch.
    </p>
    <div className="mt-6 rounded-xl bg-brand-subtle p-5">
      <p className="mb-3 font-semibold">Contact us</p>
      <SupportContact />
    </div>
  </Modal>
);

export default ShippingInfoModal;
