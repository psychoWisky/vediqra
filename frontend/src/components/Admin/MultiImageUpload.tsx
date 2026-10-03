import React, { useState } from 'react';
import { Upload, X, Camera, Star, Trash2 } from 'lucide-react';
import { uploadFetch } from '../../utils/api';

interface ImageFile {
  file?: File;
  preview: string;
  url?: string;
  is_primary: boolean;
}

interface UploadedImage {
  url: string;
  filename: string;
  is_primary: boolean;
}

interface MultiImageUploadProps {
  onImagesUploaded: (images: { url: string; is_primary: boolean }[]) => void;
  maxImages?: number;
  initialImages?: { url: string; is_primary: boolean }[];
}

const MultiImageUpload: React.FC<MultiImageUploadProps> = ({ 
  onImagesUploaded, 
  maxImages = 5,
  initialImages = []
}) => {
  const [images, setImages] = useState<ImageFile[]>(
    initialImages.map(img => ({
      preview: img.url,
      url: img.url,
      is_primary: img.is_primary
    }))
  );
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    
    if (images.length + files.length > maxImages) {
      setError(`You can only upload up to ${maxImages} images`);
      return;
    }

    const newImages: ImageFile[] = files.map((file, index) => ({
      file,
      preview: URL.createObjectURL(file),
      is_primary: images.length === 0 && index === 0
    }));

    setImages([...images, ...newImages]);
    setError(null);
  };

  const removeImage = (index: number) => {
    const newImages = images.filter((_, i) => i !== index);
    // If we removed the primary image, make the first one primary
    if (images[index]?.is_primary && newImages.length > 0) {
      newImages[0].is_primary = true;
    }
    setImages(newImages);
  };

  const setAsPrimary = (index: number) => {
    const newImages = images.map((img, i) => ({
      ...img,
      is_primary: i === index
    }));
    setImages(newImages);
  };

  const uploadImages = async () => {
    if (images.length === 0) return;

    // If all images already have URLs, just notify parent
    if (images.every(img => img.url)) {
      onImagesUploaded(images.map(img => ({
        url: img.url!,
        is_primary: img.is_primary
      })));
      return;
    }

    setUploading(true);
    setError(null);
    
    const formData = new FormData();
    let hasNewImages = false;
    
    images.forEach((img) => {
      if (img.file) { // Only upload new images
        formData.append('images', img.file);
        hasNewImages = true;
      }
    });

    if (!hasNewImages) {
      setUploading(false);
      return;
    }

    try {
      const data = await uploadFetch('/api/upload/product-images', formData);
      
      // Merge uploaded images with existing ones
      let uploadedIndex = 0;
      const updatedImages: ImageFile[] = images.map((img) => {
        if (!img.url && uploadedIndex < data.images.length) {
          const uploaded = data.images[uploadedIndex];
          uploadedIndex++;
          return {
            ...img,
            url: uploaded.url,
            is_primary: img.is_primary
          };
        }
        return img;
      });

      setImages(updatedImages);
      
      // Notify parent
      onImagesUploaded(updatedImages.map(img => ({
        url: img.url!,
        is_primary: img.is_primary
      })));

    } catch (error: any) {
      console.error('Upload error:', error);
      setError(error.message || 'Failed to upload images');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Image Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {images.map((image, index) => (
          <div key={index} className="relative group aspect-square">
            <img
              src={image.preview}
              alt={`Product ${index + 1}`}
              className="w-full h-full object-cover rounded-lg"
            />
            
            {/* Primary Badge */}
            {image.is_primary && (
              <div className="absolute top-2 left-2 bg-yellow-400 text-white p-1 rounded-full">
                <Star className="h-4 w-4 fill-current" />
              </div>
            )}

            {/* Action Buttons */}
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center gap-2">
              {!image.is_primary && (
                <button
                  type="button"
                  onClick={() => setAsPrimary(index)}
                  className="p-2 bg-blue-500 text-white rounded-full hover:bg-blue-600"
                  title="Set as primary"
                >
                  <Star className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => removeImage(index)}
                className="p-2 bg-red-500 text-white rounded-full hover:bg-red-600"
                title="Remove"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}

        {/* Upload Button */}
        {images.length < maxImages && (
          <label className="border-2 border-dashed border-gray-300 rounded-lg aspect-square flex flex-col items-center justify-center cursor-pointer hover:border-premium-gold transition-colors">
            <Camera className="h-8 w-8 text-gray-400 mb-2" />
            <span className="text-sm text-gray-500">Upload</span>
            <input
              type="file"
              multiple
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>
        )}
      </div>

      {/* Upload Button */}
      {images.length > 0 && !uploading && !images.every(img => img.url) && (
        <button
          type="button"
          onClick={uploadImages}
          className="w-full py-3 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy flex items-center justify-center gap-2"
        >
          <Upload className="h-5 w-5" />
          Upload {images.length} {images.length === 1 ? 'Image' : 'Images'}
        </button>
      )}

      {uploading && (
        <div className="text-center py-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-premium-gold mx-auto"></div>
          <p className="text-sm text-gray-600 mt-2">Uploading images...</p>
        </div>
      )}
    </div>
  );
};

export default MultiImageUpload;