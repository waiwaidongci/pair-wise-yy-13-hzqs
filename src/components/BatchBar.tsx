import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Chip,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  AccessTimeRounded,
  AddRounded,
  ChangeCircleRounded,
  CheckCircleRounded,
  GavelRounded,
  HandshakeRounded,
  HistoryRounded,
  PersonRounded,
  RefreshRounded,
  SwapHorizRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import { useReviewStore, batchHolderLabel } from "../stores/reviewStore";

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function remainingLabel(expiresAt: string, now: number): string {
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  const seconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}

export default function BatchBar() {
  const currentBatchId = useReviewStore((state) => state.currentBatchId);
  const batches = useReviewStore((state) => state.snapshot.batches);
  const conflicts = useReviewStore((state) => state.conflicts);
  const mergeStatus = useReviewStore((state) => state.mergeStatus);
  const mergeError = useReviewStore((state) => state.mergeError);
  const migrated = useReviewStore((state) => state.migrated);
  const startBatch = useReviewStore((state) => state.startBatch);
  const handbackBatch = useReviewStore((state) => state.handbackBatch);
  const takeoverBatch = useReviewStore((state) => state.takeoverBatch);
  const expireBatches = useReviewStore((state) => state.expireBatches);
  const simulateRemoteChange = useReviewStore((state) => state.simulateRemoteChange);
  const retryMerge = useReviewStore((state) => state.retryMerge);
  const bumpChangeset = useReviewStore((state) => state.bumpChangeset);
  const now = useNow(1000);

  const batch = batches.find((b) => b.id === currentBatchId);
  const conflictCount = Object.keys(conflicts).length;
  const handedBack = batches.filter((b) => b.status === "handed_back" || b.status === "expired");

  useEffect(() => {
    expireBatches();
  }, [now, expireBatches]);

  return (
    <Box
      sx={{
        px: 1.3,
        py: 0.8,
        mb: 1.2,
        display: "flex",
        alignItems: "center",
        gap: 1,
        flexWrap: "wrap",
        borderRadius: 1.5,
        border: "1px solid",
        borderColor: conflictCount > 0 ? "warning.main" : "divider",
        bgcolor: conflictCount > 0 ? "warning.50" : "background.paper",
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.6}>
        <PersonRounded fontSize="small" color="action" />
        <Typography sx={{ fontSize: 11.5, fontWeight: 850 }}>审阅批次</Typography>
      </Stack>

      {batch ? (
        <Chip
          size="small"
          icon={<AccessTimeRounded />}
          label={`${batchHolderLabel(batch)} · 剩余 ${remainingLabel(batch.expiresAt, now)}`}
          color={batch.status === "active" ? "primary" : "default"}
          variant={batch.status === "active" ? "filled" : "outlined"}
        />
      ) : (
        <Chip size="small" label="无进行中批次" variant="outlined" />
      )}

      {!batch && (
        <Button size="small" startIcon={<AddRounded />} onClick={() => startBatch()}>
          新建批次
        </Button>
      )}
      {batch?.status === "active" && (
        <Tooltip title="交回批次，文件可被他人接手">
          <Button size="small" startIcon={<HandshakeRounded />} onClick={handbackBatch}>
            交回批次
          </Button>
        </Tooltip>
      )}

      {handedBack.length > 0 && (
        <Tooltip title="接手一个已交回或超时的批次">
          <Button size="small" startIcon={<SwapHorizRounded />} onClick={() => takeoverBatch(handedBack[0].id)}>
            接手批次
          </Button>
        </Tooltip>
      )}

      <Divider />

      {conflictCount > 0 && (
        <Chip
          size="small"
          icon={<GavelRounded />}
          label={`${conflictCount} 个文件冲突待裁决`}
          color="warning"
          onDelete={retryMerge}
          deleteIcon={<RefreshRounded />}
        />
      )}
      {mergeStatus === "failed" && conflictCount === 0 && (
        <Chip
          size="small"
          icon={<WarningAmberRounded />}
          label={mergeError ?? "合并失败"}
          color="error"
          onDelete={retryMerge}
          deleteIcon={<RefreshRounded />}
        />
      )}
      {mergeStatus === "succeeded" && conflictCount === 0 && (
        <Chip size="small" icon={<CheckCircleRounded />} label="已同步" color="success" variant="outlined" />
      )}

      <Box sx={{ flex: 1 }} />

      {migrated && (
        <Tooltip title="检测到旧版本数据，已迁移为首版（补批次与持有人）">
          <Chip size="small" icon={<HistoryRounded />} label="已迁移首版" variant="outlined" />
        </Tooltip>
      )}

      <Tooltip title="模拟另一个标签页同时提交评论，验证合并不会覆盖">
        <Button size="small" startIcon={<ChangeCircleRounded />} onClick={simulateRemoteChange}>
          模拟远端提交
        </Button>
      </Tooltip>
      <Tooltip title="变更集内容变化：相关签收失效、评论定位重算">
        <Button size="small" startIcon={<RefreshRounded />} onClick={bumpChangeset}>
          变更集变更
        </Button>
      </Tooltip>
    </Box>
  );
}

function Divider() {
  return <Box sx={{ width: 1, height: 18, bgcolor: "divider", mx: 0.2 }} />;
}
