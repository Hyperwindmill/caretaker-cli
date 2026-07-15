// Central icon set for the webview UI. One place maps a UI concept to a
// concrete lucide-react icon, so every surface (web, desktop, VSCode) stays
// consistent and swapping an icon is a one-line change here.
//
// Usage: import { ToolIcon } from './icons.js'; then <ToolIcon size={14} />.
// Icons inherit `currentColor`, so keep the existing wrapping span/className
// (which carries the size/color CSS) and put the icon inside it. The default
// stroke width matches lucide's 2px; pass `size` to match the surrounding
// font-size (~14 for headers, ~12 for inline chips).

export {
  AlertTriangle as WarningIcon,
  Wrench as ToolIcon,
  Brain as ThinkingIcon,
  CornerDownRight as ResultArrowIcon,
  Loader2 as SpinnerIcon,
  Paperclip as AttachIcon,
  FileText as DocIcon,
  MessageSquare as ChatIcon,
  Folder as FolderIcon,
  FolderKanban as ProjectsIcon,
  Settings as SettingsIcon,
  Trash2 as DeleteIcon,
  Pencil as EditIcon,
  X as CloseIcon,
  Lock as LockIcon,
  Lightbulb as TipIcon,
  GitBranch as GitIcon,
  ScrollText as LogsIcon,
  Copy as CopyIcon,
  ArrowLeft as BackIcon,
  ArrowUp as UpIcon,
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  Plus as AddIcon,
  Check as CheckIcon,
  Pause as PauseIcon,
  Play as ActivateIcon,
  Circle as StatusIcon,
} from 'lucide-react';
