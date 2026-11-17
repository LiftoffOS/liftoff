import { useNavigate } from 'react-router'
import { api } from '../../services/api'
import { useTenant } from '../../hooks/useTenant'
import type { FileAttachment } from './ChatMessages'
import FileTextIcon from '../../assets/icons/file-text.svg?react'
import DownloadIcon from '../../assets/icons/download.svg?react'
import ExternalLinkIcon from '../../assets/icons/external-link.svg?react'

interface FileOutputCardProps {
  attachment: FileAttachment
}

function getConnectorDisplayName(webViewUrl?: string | null): string {
  if (!webViewUrl) return 'your cloud storage'
  if (webViewUrl.includes('docs.google.com/presentation')) return 'Google Slides'
  if (webViewUrl.includes('drive.google.com')) return 'Google Drive'
  if (webViewUrl.includes('sharepoint.com')) return 'SharePoint'
  if (webViewUrl.includes('1drv.ms') || webViewUrl.includes('onedrive.live.com') || webViewUrl.includes('onedrive.com')) return 'OneDrive'
  if (webViewUrl.includes('dropbox.com')) return 'Dropbox'
  if (webViewUrl.includes('box.com')) return 'Box'
  return 'your cloud storage'
}

export function FileOutputCard({ attachment }: FileOutputCardProps) {
  const { filename, downloadUrl, webViewUrl, generatedFileId } = attachment
  const { currentTenant } = useTenant()
  const navigate = useNavigate()

  const handleDownload = async () => {
    let freshUrl = downloadUrl

    try {
      const params = new URLSearchParams({ tenantId: currentTenant?.id ?? '' })
      const result = await api.get<{ downloadUrl: string }>(
        `/api/generated-files/${generatedFileId}/download?${params.toString()}`,
      )
      freshUrl = result.downloadUrl
    } catch {
      // Fall back to the cached URL — may 403 if older than 1 hour
    }

    try {
      const res = await fetch(freshUrl ?? '')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      window.open(freshUrl ?? '', '_blank')
    }
  }

  return (
    <div className="file-output-card">
      <div className="file-output-card__icon">
        <FileTextIcon />
      </div>
      <span className="file-output-card__name">{filename}</span>
      <div className="file-output-card__actions">
        {downloadUrl !== null && (
          <button
            className="file-output-card__action-btn"
            onClick={handleDownload}
            aria-label="Download"
          >
            <DownloadIcon />
          </button>
        )}
        {webViewUrl ? (
          <a
            className="file-output-card__action-btn"
            href={webViewUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open in ${getConnectorDisplayName(webViewUrl)}`}
          >
            <ExternalLinkIcon />
          </a>
        ) : (
          // No link into the connector means the copy did not reach it. The
          // card cannot tell WHY from here: the platform only hears about a
          // sync that succeeded, so an auth failure, a vendor error and a
          // connector that never syncs all arrive as the same absence. Four
          // words that are true, in the slot the open icon would fill; the
          // download icon beside them already says the file is here. The
          // arrow goes to the connections page without asserting anything
          // about the connection.
          <button
            className="file-output-card__reauth-link"
            onClick={() => navigate('/dashboard/connections')}
          >
            Not in {getConnectorDisplayName()} &rarr;
          </button>
        )}
      </div>
    </div>
  )
}
