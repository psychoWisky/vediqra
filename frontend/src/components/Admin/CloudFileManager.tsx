import React, { useState, useEffect, useCallback } from 'react';
import {
  Trash2, RefreshCw, CheckSquare, Square, Image as ImageIcon,
  Film, FileImage, Search, X, AlertTriangle, Folder, ChevronRight
} from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import toast from 'react-hot-toast';

interface CloudFile {
  key: string;
  size: number;
  lastModified: string;
  url: string;
}

const FOLDERS = [
  { label: 'All Files', prefix: '' },
  { label: 'Products', prefix: 'products/' },
  { label: 'Heroes', prefix: 'heroes/' },
  { label: 'Popups', prefix: 'popups/' },
  { label: 'Categories', prefix: 'categories/' },
  { label: 'Customizations', prefix: 'customizations/' },
];

const isVideo = (key: string) => /\.(mp4|webm|mov|avi)$/i.test(key);
const isGif   = (key: string) => /\.gif$/i.test(key);
const isImage = (key: string) => /\.(jpe?g|png|webp|gif)$/i.test(key);

const formatBytes = (bytes?: number) => {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const CloudFileManager: React.FC = () => {
  const { fetchWithAuth } = useApi();
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [activeFolder, setActiveFolder] = useState('');
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fetchFiles = useCallback(async (prefix = activeFolder) => {
    setLoading(true);
    setSelectedKeys(new Set());
    try {
      const data = await fetchWithAuth(`/api/upload/list-files?prefix=${encodeURIComponent(prefix)}`);
      setFiles(data.files || []);
    } catch {
      toast.error('Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [activeFolder]);

  useEffect(() => { fetchFiles(activeFolder); }, [activeFolder]);

  const filteredFiles = files.filter(f => {
    if (!search.trim()) return true;
    return f.key.toLowerCase().includes(search.toLowerCase());
  });

  const toggleSelect = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedKeys.size === filteredFiles.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(filteredFiles.map(f => f.key)));
    }
  };

  const deleteSelected = async () => {
    if (selectedKeys.size === 0) return;
    setDeleting(true);
    setConfirmDelete(false);
    try {
      await fetchWithAuth('/api/upload/delete-files', {
        method: 'DELETE',
        body: JSON.stringify({ keys: Array.from(selectedKeys) }),
      });
      toast.success(`Deleted ${selectedKeys.size} file(s)`);
      setSelectedKeys(new Set());
      fetchFiles(activeFolder);
    } catch {
      toast.error('Failed to delete files');
    } finally {
      setDeleting(false);
    }
  };

  const FileThumb: React.FC<{ file: CloudFile; selected: boolean }> = ({ file, selected }) => {
    const [imgError, setImgError] = useState(false);
    const name = file.key.split('/').pop() || file.key;

    return (
      <div
        onClick={() => toggleSelect(file.key)}
        className={`relative rounded-xl border-2 cursor-pointer transition-all overflow-hidden group ${
          selected ? 'border-premium-gold bg-premium-gold/5 shadow-md' : 'border-gray-200 hover:border-gray-300'
        }`}
      >
        {/* Checkbox */}
        <div className="absolute top-2 left-2 z-10">
          {selected
            ? <CheckSquare className="h-5 w-5 text-premium-gold drop-shadow" />
            : <Square className="h-5 w-5 text-white drop-shadow opacity-70 group-hover:opacity-100" />
          }
        </div>

        {/* Media preview */}
        <div className="aspect-square bg-gray-100 flex items-center justify-center">
          {isVideo(file.key) ? (
            <div className="flex flex-col items-center gap-1 text-gray-400 p-2">
              <Film className="h-10 w-10" />
              <span className="text-xs">Video</span>
            </div>
          ) : isImage(file.key) && !imgError ? (
            <img
              src={file.url}
              alt={name}
              className="w-full h-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="flex flex-col items-center gap-1 text-gray-400 p-2">
              <FileImage className="h-10 w-10" />
              <span className="text-xs">File</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="p-2 bg-white">
          <p className="text-xs text-gray-700 truncate font-medium" title={name}>{name}</p>
          <p className="text-xs text-gray-400">{formatBytes(file.size)}</p>
        </div>

        {selected && (
          <div className="absolute inset-0 ring-2 ring-premium-gold ring-inset rounded-xl pointer-events-none" />
        )}
      </div>
    );
  };

  return (
    <div className="bg-white rounded-xl shadow overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-serif font-semibold flex items-center gap-2">
            <Folder className="h-6 w-6 text-premium-gold" />
            Cloud Storage
          </h2>
          <div className="flex items-center gap-2">
            {selectedKeys.size > 0 && (
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
                className="flex items-center gap-2 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 text-sm"
              >
                <Trash2 className="h-4 w-4" />
                Delete {selectedKeys.size} selected
              </button>
            )}
            <button
              onClick={() => fetchFiles(activeFolder)}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg hover:bg-gray-50 text-sm"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="flex">
        {/* Sidebar folders */}
        <div className="w-44 border-r bg-gray-50 p-3 space-y-1 flex-shrink-0">
          {FOLDERS.map(f => (
            <button
              key={f.prefix}
              onClick={() => setActiveFolder(f.prefix)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors ${
                activeFolder === f.prefix
                  ? 'bg-premium-gold text-white font-medium'
                  : 'text-gray-700 hover:bg-gray-200'
              }`}
            >
              <Folder className="h-4 w-4 flex-shrink-0" />
              {f.label}
            </button>
          ))}
        </div>

        {/* Main content */}
        <div className="flex-1 p-4 min-w-0">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search files…"
                className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm focus:border-premium-gold focus:outline-none"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                  <X className="h-4 w-4 text-gray-400" />
                </button>
              )}
            </div>
            <button
              onClick={selectAll}
              className="flex items-center gap-2 px-3 py-2 border rounded-lg text-sm hover:bg-gray-50"
            >
              {selectedKeys.size === filteredFiles.length && filteredFiles.length > 0
                ? <CheckSquare className="h-4 w-4 text-premium-gold" />
                : <Square className="h-4 w-4" />
              }
              {selectedKeys.size === filteredFiles.length && filteredFiles.length > 0 ? 'Deselect All' : 'Select All'}
            </button>
            <span className="text-sm text-gray-500">{filteredFiles.length} files</span>
          </div>

          {/* Files grid */}
          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {[...Array(12)].map((_, i) => (
                <div key={i} className="rounded-xl border bg-gray-100 animate-pulse">
                  <div className="aspect-square" />
                  <div className="p-2 h-8 bg-gray-200 rounded-b-xl" />
                </div>
              ))}
            </div>
          ) : filteredFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <ImageIcon className="h-16 w-16 mb-4 opacity-30" />
              <p className="text-lg font-medium">No files found</p>
              {search && <p className="text-sm mt-1">Try a different search term</p>}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {filteredFiles.map(file => (
                <FileThumb
                  key={file.key}
                  file={file}
                  selected={selectedKeys.has(file.key)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirm dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[400] p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 bg-red-100 rounded-full">
                <AlertTriangle className="h-6 w-6 text-red-600" />
              </div>
              <div>
                <h3 className="font-bold text-lg">Delete Files?</h3>
                <p className="text-sm text-gray-500">This cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-gray-700 mb-6">
              You are about to permanently delete <strong>{selectedKeys.size}</strong> file(s) from Cloudflare R2.
              Any products or pages using these files will show broken images.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(false)}
                className="flex-1 px-4 py-2 border rounded-lg hover:bg-gray-50 font-medium"
              >
                Cancel
              </button>
              <button
                onClick={deleteSelected}
                disabled={deleting}
                className="flex-1 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 font-medium disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : `Delete ${selectedKeys.size} file(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CloudFileManager;
