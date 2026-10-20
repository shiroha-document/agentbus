import * as RSwitch from "@radix-ui/react-switch";
import { motion } from "motion/react";
import { springSnappy } from "../../lib/motion";
import { cn } from "../../lib/util";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  tone = "mint",
  id,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  tone?: "mint" | "warning";
  id?: string;
}) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "relative inline-flex h-[26px] w-[44px] flex-none items-center rounded-full border border-line p-[2px] transition-colors duration-200 disabled:opacity-40",
        checked ? (tone === "warning" ? "bg-warning" : "bg-mint-500") : "bg-mint-200",
      )}
      style={{ justifyContent: checked ? "flex-end" : "flex-start" }}
    >
      <RSwitch.Thumb asChild>
        <motion.span layout transition={springSnappy} className="block h-5 w-5 rounded-full bg-surface-solid shadow-1" />
      </RSwitch.Thumb>
    </RSwitch.Root>
  );
}
