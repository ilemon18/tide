import { Icon } from './Icon'
import claudeIcon from '../assets/agentIcons/claude.svg'
import codexIcon from '../assets/agentIcons/codex.svg'
import copilotIcon from '../assets/agentIcons/copilot.svg'
import cursorIcon from '../assets/agentIcons/cursor.svg'
import geminiIcon from '../assets/agentIcons/gemini.svg'
import gooseIcon from '../assets/agentIcons/goose.svg'
import opencodeIcon from '../assets/agentIcons/opencode.svg'
import qwenIcon from '../assets/agentIcons/qwen.svg'

/** Official provider icons from openidea. */
const PROVIDER_IMAGES: Record<string, string> = {
  claude: claudeIcon,
  codex: codexIcon,
  copilot: copilotIcon,
  cursor: cursorIcon,
  gemini: geminiIcon,
  goose: gooseIcon,
  opencode: opencodeIcon,
  qwen: qwenIcon,
}

type Props = {
  provider: string
  size?: number
  className?: string
}

export function AgentProviderIcon({ provider, size = 16, className }: Props) {
  const image = PROVIDER_IMAGES[provider]
  if (image) {
    return (
      <img
        src={image}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={className ? `${className} object-contain` : 'object-contain'}
      />
    )
  }
  return <Icon name="agent" size={size} className={className} />
}
