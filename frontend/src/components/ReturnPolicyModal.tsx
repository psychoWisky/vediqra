import React from 'react';
import { Modal } from './ui/Modal';
import SupportContact from './SupportContact';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const ReturnPolicyModal: React.FC<Props> = ({ isOpen, onClose }) => (
  <Modal isOpen={isOpen} onClose={onClose} title="Returns policy" widthClass="max-w-lg">
    <p className="text-sm text-brand-muted">
      The returns and refunds policy will be published here once confirmed. Personalised items are made to order, so their terms may differ from standard products.
    </p>
    <p className="mt-3 text-sm text-brand-muted">If there is a problem with an order, please contact us and quote your order number.</p>
    <div className="mt-6 rounded-xl bg-brand-subtle p-5">
      <p className="mb-3 font-semibold">Contact us</p>
      <SupportContact />
    </div>
  </Modal>
);

export default ReturnPolicyModal;
