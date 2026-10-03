import React, { useState, useEffect } from 'react';
import { getImageUrl } from '../utils/helpers';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Clock, Gift } from 'lucide-react';
import { apiFetch, uploadFetch } from '../utils/api';
import { PopupConfig } from '../types';

interface PopupProps {
  onClose: () => void;
}

const Popup: React.FC<PopupProps> = ({ onClose }) => {
  const [popup, setPopup] = useState<PopupConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeLeft, setTimeLeft] = useState({ hours: 0, minutes: 0, seconds: 0 });
  const [sessionId] = useState(() => Math.random().toString(36).substring(7));

  // Get initial timer from localStorage or API
  const getInitialTimer = (popupData: PopupConfig) => {
    const savedTimer = localStorage.getItem(`popup_timer_${popupData.id}`);
    if (savedTimer) {
      return JSON.parse(savedTimer);
    }
    return {
      hours: popupData.timer_hours,
      minutes: popupData.timer_minutes,
      seconds: popupData.timer_seconds
    };
  };

  useEffect(() => {
    fetchPopup();
  }, []);

  useEffect(() => {
    if (popup?.timer_enabled) {
      // Load saved timer state
      const savedTimer = getInitialTimer(popup);
      setTimeLeft(savedTimer);

      const timer = setInterval(() => {
        setTimeLeft(prev => {
          if (prev.hours === 0 && prev.minutes === 0 && prev.seconds === 0) {
            clearInterval(timer);
            return prev;
          }

          let newSeconds = prev.seconds - 1;
          let newMinutes = prev.minutes;
          let newHours = prev.hours;

          if (newSeconds < 0) {
            newSeconds = 59;
            newMinutes -= 1;
          }

          if (newMinutes < 0) {
            newMinutes = 59;
            newHours -= 1;
          }

          const newTime = {
            hours: newHours,
            minutes: newMinutes,
            seconds: newSeconds
          };

          // Save to localStorage
          localStorage.setItem(`popup_timer_${popup.id}`, JSON.stringify(newTime));
          
          return newTime;
        });
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [popup]);

  const fetchPopup = async () => {
    try {
      const data = await apiFetch('/api/popups/active');
      setPopup(data);
      
      if (data) {
        await apiFetch('/api/popups/track-view', {
          method: 'POST',
          body: JSON.stringify({ 
            popup_id: data.id,
            session_id: sessionId 
          }),
        });
      }
    } catch (error) {
      console.error('Error fetching popup:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCTAClick = async () => {
    if (popup) {
      await apiFetch('/api/popups/track-click', {
        method: 'POST',
        body: JSON.stringify({ 
          popup_id: popup.id,
          session_id: sessionId 
        }),
      });
    }
    window.location.href = popup?.cta_link || '/products?category=holi';
  };

  if (loading || !popup) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          className="relative bg-white rounded-2xl max-w-sm w-full shadow-2xl overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close Button */}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 z-10 p-1.5 bg-white/90 rounded-full shadow-md hover:bg-gray-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Image Section */}
          <div className="relative h-32 bg-brand-ink">
            {popup.image_url ? (
              <img
                src={getImageUrl(popup.image_url)}
                alt={popup.title}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <Gift className="w-12 h-12 text-white/30" />
              </div>
            )}
            
            {/* Discount Badge */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3">
              <span className="text-white font-bold text-lg">
                {popup.discount_text.replace('{value}', popup.discount_value)}
              </span>
            </div>
          </div>

          {/* Content Section */}
          <div className="p-4">
            <h3 className="font-bold text-gray-800 mb-1">{popup.title}</h3>
            <p className="text-sm text-gray-600 mb-3">{popup.description}</p>

            {/* Timer */}
            {popup.timer_enabled && (
              <div className="mb-3">
                <p className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {popup.offer_text}
                </p>
                <div className="flex gap-1.5">
                  <div className="flex-1 bg-gray-100 rounded-lg py-1.5 text-center">
                    <span className="text-lg font-bold text-orange-500">
                      {String(timeLeft.hours).padStart(2, '0')}
                    </span>
                    <span className="text-xs text-gray-500 block">hrs</span>
                  </div>
                  <div className="flex-1 bg-gray-100 rounded-lg py-1.5 text-center">
                    <span className="text-lg font-bold text-orange-500">
                      {String(timeLeft.minutes).padStart(2, '0')}
                    </span>
                    <span className="text-xs text-gray-500 block">min</span>
                  </div>
                  <div className="flex-1 bg-gray-100 rounded-lg py-1.5 text-center">
                    <span className="text-lg font-bold text-orange-500">
                      {String(timeLeft.seconds).padStart(2, '0')}
                    </span>
                    <span className="text-xs text-gray-500 block">sec</span>
                  </div>
                </div>
              </div>
            )}

            {/* CTA Button */}
            <button
              onClick={handleCTAClick}
              className="w-full bg-orange-500 text-white py-2.5 rounded-lg font-medium text-sm hover:bg-orange-600 transition-colors flex items-center justify-center gap-1.5"
            >
              <Gift className="h-4 w-4" />
              {popup.cta_text} • {popup.cash_on_delivery_text}
            </button>

            {/* Prepaid Discount */}
            {popup.prepaid_discount_text && (
              <p className="text-xs text-center text-green-600 mt-2">
                💳 {popup.prepaid_discount_text}
              </p>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default Popup;