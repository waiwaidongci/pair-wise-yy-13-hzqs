import {
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import {
  CheckCircleRounded,
  ExpandMoreRounded,
  GavelRounded,
  PersonRounded,
} from "@mui/icons-material";
import { useState } from "react";
import { useReviewStore } from "../stores/reviewStore";
import type { FileConflict } from "../types/review";

function ProgressSummary({ label, progress, color }: { label: string; progress: FileConflict["local"]; color: "primary" | "secondary" | "default" }) {
  return (
    <Box sx={{ flex: 1, p: 1, borderRadius: 1, border: "1px solid", borderColor: "divider" }}>
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
        <Chip size="small" label={label} color={color} />
        {progress.holder && (
          <Chip size="small" icon={<PersonRounded />} label={progress.holder} variant="outlined" />
        )}
      </Stack>
      <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>
        签收：{progress.signoffStatus} · 评论 {progress.comments.length} 条
      </Typography>
      {progress.comments.slice(0, 3).map((comment) => (
        <Typography key={comment.id} sx={{ fontSize: 10, color: "text.secondary", mt: 0.3 }} noWrap>
          · {comment.body}
        </Typography>
      ))}
      {progress.comments.length > 3 && (
        <Typography sx={{ fontSize: 10, color: "text.secondary" }}>… 还有 {progress.comments.length - 3} 条</Typography>
      )}
    </Box>
  );
}

function ConflictCard({ conflict }: { conflict: FileConflict }) {
  const adjudicateConflict = useReviewStore((state) => state.adjudicateConflict);
  const [expanded, setExpanded] = useState(false);
  const fileName = conflict.fileId;

  return (
    <Paper variant="outlined" sx={{ p: 1.2, borderColor: "warning.main", bgcolor: "warning.50" }}>
      <Stack direction="row" alignItems="center" spacing={0.8}>
        <GavelRounded fontSize="small" color="warning" />
        <Typography sx={{ fontSize: 12, fontWeight: 850, flex: 1 }}>
          冲突：{fileName}
        </Typography>
        <Chip size="small" label="两边都改过" color="warning" />
        <Button size="small" endIcon={<ExpandMoreRounded />} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : "对比"}
        </Button>
      </Stack>

      <Collapse in={expanded}>
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <ProgressSummary label="本地" progress={conflict.local} color="primary" />
          <ProgressSummary label="远端" progress={conflict.remote} color="secondary" />
        </Stack>
        <Divider sx={{ my: 1 }} />
        <Stack direction="row" spacing={0.8} justifyContent="flex-end">
          <Button size="small" variant="outlined" onClick={() => adjudicateConflict(conflict.fileId, "base")}>
            保留 base
          </Button>
          <Button size="small" variant="outlined" startIcon={<CheckCircleRounded />} onClick={() => adjudicateConflict(conflict.fileId, "remote")}>
            采用远端
          </Button>
          <Button size="small" variant="contained" startIcon={<CheckCircleRounded />} onClick={() => adjudicateConflict(conflict.fileId, "local")}>
            采用本地
          </Button>
        </Stack>
      </Collapse>
    </Paper>
  );
}

export default function ConflictPanel() {
  const conflicts = useReviewStore((state) => state.conflicts);
  const conflictList = Object.values(conflicts);

  if (conflictList.length === 0) return null;

  return (
    <Box sx={{ mb: 1.2 }}>
      <Stack spacing={1}>
        {conflictList.map((conflict) => (
          <ConflictCard key={conflict.fileId} conflict={conflict} />
        ))}
      </Stack>
    </Box>
  );
}
