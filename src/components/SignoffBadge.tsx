import { Chip, Tooltip } from "@mui/material";
import {
  CheckCircleRounded,
  GavelRounded,
  HourglassEmptyRounded,
  LockRounded,
  PersonRounded,
} from "@mui/icons-material";
import type { FileProgress } from "../types/review";
import { isClaimable, isClaimExpired, isConflicted, isSigned } from "../utils/batch";

interface SignoffBadgeProps {
  progress: FileProgress | undefined;
  size?: "small" | "medium";
}

export default function SignoffBadge({ progress, size = "small" }: SignoffBadgeProps) {
  if (!progress) return null;

  if (isConflicted(progress)) {
    return (
      <Tooltip title="两边都修改了此文件，已各留一份，需裁决后才能完成">
        <Chip size={size} icon={<GavelRounded />} label="冲突" color="warning" />
      </Tooltip>
    );
  }

  if (isSigned(progress)) {
    return (
      <Tooltip title={`已签收${progress.holder ? ` · ${progress.holder}` : ""}`}>
        <Chip size={size} icon={<CheckCircleRounded />} label="已签收" color="success" />
      </Tooltip>
    );
  }

  if (progress.signoffStatus === "claimed") {
    const expired = isClaimExpired(progress);
    if (expired) {
      return (
        <Tooltip title="认领已超时，他人可接手">
          <Chip size={size} icon={<HourglassEmptyRounded />} label="认领超时" color="default" variant="outlined" />
        </Tooltip>
      );
    }
    return (
      <Tooltip title={`已被 ${progress.holder ?? "未知"} 认领，他人暂不能签收`}>
        <Chip size={size} icon={<LockRounded />} label={progress.holder ?? "已认领"} color="primary" variant="outlined" />
      </Tooltip>
    );
  }

  if (isClaimable(progress)) {
    return (
      <Tooltip title="待签收：先到者领走，超时或交回后他人可接手">
        <Chip size={size} icon={<PersonRounded />} label="待签收" variant="outlined" />
      </Tooltip>
    );
  }

  return <Chip size={size} label="未知" variant="outlined" />;
}
