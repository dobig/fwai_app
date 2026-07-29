import { Check, Copy, Edit, Play, Terminal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ProviderActionsProps {
  isCurrent: boolean;
  onSwitch: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onOpenTerminal?: () => void;
}

export function ProviderActions({
  isCurrent,
  onSwitch,
  onEdit,
  onDuplicate,
  onDelete,
  onOpenTerminal,
}: ProviderActionsProps) {
  const { t } = useTranslation();
  const iconButtonClass = "h-8 w-8 p-1";

  const buttonState = isCurrent
    ? {
        disabled: true,
        variant: "secondary" as const,
        className:
          "bg-gray-200 text-muted-foreground hover:bg-gray-200 hover:text-muted-foreground dark:bg-gray-700 dark:hover:bg-gray-700",
        icon: <Check className="h-4 w-4" />,
        text: t("provider.inUse"),
      }
    : {
        disabled: false,
        variant: "default" as const,
        className: "",
        icon: <Play className="h-4 w-4" />,
        text: t("provider.enable"),
      };

  const canDelete = !isCurrent;

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant={buttonState.variant}
        onClick={onSwitch}
        disabled={buttonState.disabled}
        className={cn("w-[4.5rem] px-2.5", buttonState.className)}
      >
        {buttonState.icon}
        {buttonState.text}
      </Button>

      <div className="flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          onClick={onEdit}
          title={t("common.edit")}
          className={iconButtonClass}
        >
          <Edit className="h-4 w-4" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          onClick={onDuplicate}
          title={t("provider.duplicate")}
          className={iconButtonClass}
        >
          <Copy className="h-4 w-4" />
        </Button>

        {onOpenTerminal && (
          <Button
            size="icon"
            variant="ghost"
            onClick={onOpenTerminal}
            title={t("provider.openTerminal", "打开终端")}
            className={cn(
              iconButtonClass,
              "hover:text-emerald-600 dark:hover:text-emerald-400",
            )}
          >
            <Terminal className="h-4 w-4" />
          </Button>
        )}

        <Button
          size="icon"
          variant="ghost"
          onClick={canDelete ? onDelete : undefined}
          title={t("common.delete")}
          className={cn(
            iconButtonClass,
            canDelete && "hover:text-red-500 dark:hover:text-red-400",
            !canDelete && "opacity-40 cursor-not-allowed text-muted-foreground",
          )}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
