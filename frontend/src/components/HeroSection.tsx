import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, Pause, Volume2, VolumeX, ChevronLeft, ChevronRight } from 'lucide-react';
import { HeroContent } from '../types';

interface HeroSectionProps {
  heroes: HeroContent[];
  autoplay?: boolean;
  interval?: number;
}

const HeroSection: React.FC<HeroSectionProps> = ({
  heroes,
  autoplay = true,
  interval = 5000
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoplay);
  const [isMuted, setIsMuted] = useState(true);
  const [isVideoLoaded, setIsVideoLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout>();

  const currentHero = heroes[currentIndex] || heroes[0];

  useEffect(() => {
    if (heroes.length === 0) return;

    if (isPlaying) {
      timeoutRef.current = setTimeout(() => {
        nextSlide();
      }, interval);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [currentIndex, isPlaying, heroes.length]);

  useEffect(() => {
    if (videoRef.current) {
      if (currentHero?.media_type === 'video') {
        videoRef.current.load();
        setIsVideoLoaded(false);
      }
    }
  }, [currentIndex]);

  const nextSlide = () => {
    setCurrentIndex((prev) => (prev + 1) % heroes.length);
  };

  const prevSlide = () => {
    setCurrentIndex((prev) => (prev - 1 + heroes.length) % heroes.length);
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play();
        setIsPlaying(true);
      } else {
        videoRef.current.pause();
        setIsPlaying(false);
      }
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(!isMuted);
    }
  };

  // Get alignment classes based on content_alignment
  const getAlignmentClasses = () => {
    const alignment = currentHero.content_alignment || 'center';
    
    switch(alignment) {
      case 'left':
        return {
          container: 'justify-start',
          text: 'text-left',
          content: 'max-w-3xl'
        };
      case 'right':
        return {
          container: 'justify-end',
          text: 'text-right',
          content: 'max-w-3xl'
        };
      case 'center':
      default:
        return {
          container: 'justify-center',
          text: 'text-center',
          content: 'max-w-3xl mx-auto'
        };
    }
  };

  const alignment = getAlignmentClasses();

  if (heroes.length === 0) {
    return null;
  }

  return (
    <div className="relative h-screen max-h-[800px] min-h-[600px] overflow-hidden">
      {/* Background Media */}
      <AnimatePresence mode="wait">
        <motion.div
          key={currentIndex}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1 }}
          className="absolute inset-0"
        >
          {currentHero.media_type === 'video' ? (
            <>
              <video
                ref={videoRef}
                src={currentHero.media_url}
                poster={currentHero.video_poster_url}
                autoPlay={currentHero.autoplay}
                loop={currentHero.loop}
                muted={currentHero.muted}
                playsInline
                onLoadedData={() => setIsVideoLoaded(true)}
                className="w-full h-full object-cover"
              />
              {!isVideoLoaded && (
                <div className="absolute inset-0 bg-gray-900 animate-pulse flex items-center justify-center">
                  <div className="text-white">Loading video...</div>
                </div>
              )}
            </>
          ) : (
            <img
              src={currentHero.media_url}
              alt={currentHero.title}
              className="w-full h-full object-cover"
            />
          )}
          
          {/* Dynamic Overlay - changes based on content alignment */}
          <div 
            className={`absolute inset-0 ${
              alignment.text === 'text-left' 
                ? 'bg-gradient-to-r from-black/80 via-black/60 to-transparent' 
                : alignment.text === 'text-right'
                ? 'bg-gradient-to-l from-black/80 via-black/60 to-transparent'
                : 'bg-black/50'
            }`} 
          />
        </motion.div>
      </AnimatePresence>

      {/* Content - Dynamically positioned based on alignment */}
      <div className={`relative h-full flex items-center z-10 ${alignment.container}`}>
        <div className="container mx-auto px-4">
          <motion.div
            key={currentIndex}
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className={`${alignment.content} ${alignment.text} text-white`}
          >
            <h1 className="text-5xl md:text-7xl font-heading font-bold mb-6 leading-tight">
              {currentHero.title}
            </h1>
            <p className="text-xl md:text-2xl text-gray-200 mb-8 leading-relaxed">
              {currentHero.subtitle}
            </p>
            {currentHero.cta_text && currentHero.cta_link && (
              <a
                href={currentHero.cta_link}
                className={`inline-flex items-center px-8 py-4 bg-brand-ink text-white rounded-xl hover:bg-white hover:text-brand-ink transition-all duration-300 text-lg font-medium group ${
                  alignment.text === 'text-center' ? 'mx-auto' : ''
                }`}
              >
                {currentHero.cta_text}
                <ChevronRight className="ml-2 h-5 w-5 group-hover:translate-x-2 transition-transform" />
              </a>
            )}
          </motion.div>
        </div>
      </div>

      {/* Video Controls (only for video) */}
      {currentHero.media_type === 'video' && (
        <div className="absolute bottom-8 right-8 z-20 flex gap-2">
          <button
            onClick={togglePlay}
            className="p-3 bg-white/20 backdrop-blur-sm rounded-full hover:bg-white/40 transition-colors text-white"
          >
            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </button>
          <button
            onClick={toggleMute}
            className="p-3 bg-white/20 backdrop-blur-sm rounded-full hover:bg-white/40 transition-colors text-white"
          >
            {isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
        </div>
      )}

      {/* Navigation Arrows - Only show if more than one hero */}
      {heroes.length > 1 && (
        <>
          <button
            onClick={prevSlide}
            className="absolute left-8 top-1/2 -translate-y-1/2 z-20 p-3 bg-white/20 backdrop-blur-sm rounded-full hover:bg-white/40 transition-colors text-white"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            onClick={nextSlide}
            className="absolute right-8 top-1/2 -translate-y-1/2 z-20 p-3 bg-white/20 backdrop-blur-sm rounded-full hover:bg-white/40 transition-colors text-white"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      {/* Slide Indicators */}
      {heroes.length > 1 && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 flex gap-2">
          {heroes.map((_, index) => (
            <button
              key={index}
              onClick={() => setCurrentIndex(index)}
              className={`h-2 rounded-full transition-all ${
                index === currentIndex
                  ? 'w-8 bg-brand-ink'
                  : 'w-2 bg-white/50 hover:bg-white/80'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default HeroSection;