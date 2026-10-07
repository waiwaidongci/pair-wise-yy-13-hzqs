import {
  Box,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import { HistoryRounded } from "@mui/icons-material";
import type { SharedReviewDoc } from "../types/review";

function shortBatchId(id: string): string {
  return id.length > 22 ? `…${id.slice(-14)}` : id;
}

/** 审阅批次时间线：每次提交落库的操作集合，串起评论线程与文件签收 */
export default function BatchHistoryDialog({ doc, open, onClose }: { doc: SharedReviewDoc; open: boolean; onClose: () => void }) {
  const batches = [...doc.batches].reverse();
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, py: 1.4 }}>
        <HistoryRounded color="primary" />
        <Box sx={{ flex: 1 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 950 }}>审阅批次</Typography>
          <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
            每次提交为一个批次，评论与签收都挂在批次上；批次号也是重试的幂等键
          </Typography>
        </Box>
        <Chip size="small" label={`${batches.length} 个批次`} />
      </DialogTitle>
      <DialogContent dividers sx={{ p: 1.6 }}>
        <Stack spacing={1} divider={<Divider flexItem />}>
          {batches.map((batch) => (
            <Box key={batch.id}>
              <Stack direction="row" alignItems="center" spacing={0.8}>
                <Chip size="small" variant="outlined" label={shortBatchId(batch.id)} sx={{ fontFamily: "monospace", height: 20, fontSize: 9.5 }} />
                <Typography sx={{ fontSize: 11, fontWeight: 850 }}>{batch.author}</Typography>
                <Typography sx={{ ml: "auto", fontSize: 9.5, color: "text.secondary" }}>
                  {new Date(batch.createdAt).toLocaleString("zh-CN", { hour12: false })}
                </Typography>
              </Stack>
              <Typography sx={{ mt: 0.5, fontSize: 11, color: "text.secondary" }}>
                {batch.summary} · 变更集 {batch.changesetRev || "—"}
              </Typography>
            </Box>
          ))}
          {batches.length === 0 && (
            <Typography sx={{ py: 4, textAlign: "center", fontSize: 12, color: "text.secondary" }}>还没有批次记录</Typography>
          )}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
