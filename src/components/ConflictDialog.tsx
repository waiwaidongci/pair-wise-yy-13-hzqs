import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { CallSplitRounded, GavelRounded } from "@mui/icons-material";
import type { MergeConflict, SharedReviewDoc } from "../types/review";
import { openConflictsOf, useReviewStore } from "../stores/reviewStore";

function shortBatch(batchId: string): string {
  if (batchId.startsWith("batch-legacy")) return "迁移批次";
  if (batchId.startsWith("batch-seed")) return "种子批次";
  return batchId.length > 18 ? `…${batchId.slice(-10)}` : batchId;
}

function fieldLabel(conflict: MergeConflict): string {
  if (conflict.entity === "signoff") return "文件签收";
  if (conflict.field === "resolved") return "评论解决状态";
  if (conflict.field === "_deleted") return "评论删除";
  if (conflict.field === "_parent-deleted") return "回复已删除的评论";
  return conflict.field;
}

function valueLabel(conflict: MergeConflict, side: "incoming" | "current"): string {
  const variant = side === "incoming" ? conflict.incoming : conflict.current;
  if (!variant) return "（已删除）";
  if (conflict.entity === "signoff") {
    return variant.value ? `签收（${(variant.value as { signedBy?: string }).signedBy ?? variant.author}）` : "取消签收";
  }
  if (conflict.field === "resolved") return variant.value ? "标记为已解决" : "重新打开";
  if (conflict.field === "_deleted") return side === "incoming" ? "删除该评论" : "保留对方编辑后的评论";
  if (conflict.field === "_parent-deleted") return side === "incoming" ? "保留回复并恢复评论" : "保持评论已删除";
  return JSON.stringify(variant.value);
}

function VariantCard({
  title,
  color,
  conflict,
  side,
}: {
  title: string;
  color: "primary" | "warning";
  conflict: MergeConflict;
  side: "incoming" | "current";
}) {
  const variant = side === "incoming" ? conflict.incoming : conflict.current;
  return (
    <Paper variant="outlined" sx={{ flex: 1, p: 1.1, borderColor: `${color}.light` }}>
      <Stack direction="row" alignItems="center" spacing={0.6}>
        <Chip size="small" color={color} label={title} sx={{ height: 19, fontSize: 9.5 }} />
        <Typography sx={{ fontSize: 10.5, fontWeight: 850 }}>{variant?.author ?? "—"}</Typography>
      </Stack>
      <Typography sx={{ mt: 0.7, fontSize: 11.5, fontWeight: 750 }}>{valueLabel(conflict, side)}</Typography>
      <Typography sx={{ mt: 0.4, fontSize: 9.5, color: "text.secondary" }}>
        批次 {shortBatch(variant?.batchId ?? "")} · {variant ? new Date(variant.at).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}
      </Typography>
    </Paper>
  );
}

export default function ConflictDialog({ doc, open, onClose }: { doc: SharedReviewDoc; open: boolean; onClose: () => void }) {
  const adjudicate = useReviewStore((state) => state.adjudicate);
  const conflicts = openConflictsOf(doc);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, py: 1.4 }}>
        <GavelRounded color="warning" />
        <Box sx={{ flex: 1 }}>
          <Typography sx={{ fontSize: 15, fontWeight: 950 }}>合并冲突裁决</Typography>
          <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
            两边都改过同一实体，已各留一份；裁决前对应文件不能完成签收
          </Typography>
        </Box>
        <Chip size="small" color="warning" label={`${conflicts.length} 个待裁决`} />
      </DialogTitle>
      <DialogContent dividers sx={{ p: 1.6 }}>
        {conflicts.length === 0 && (
          <Box sx={{ py: 5, textAlign: "center", color: "text.secondary" }}>
            <CallSplitRounded sx={{ fontSize: 32, opacity: 0.4 }} />
            <Typography sx={{ mt: 1, fontSize: 12 }}>没有待裁决的冲突</Typography>
          </Box>
        )}
        <Stack spacing={1.4}>
          {conflicts.map((conflict) => {
            const file = doc.files.find((item) => item.id === conflict.fileId);
            return (
              <Paper key={conflict.id} variant="outlined" sx={{ p: 1.3 }}>
                <Stack direction="row" alignItems="center" spacing={0.8} sx={{ mb: 1 }}>
                  <Chip size="small" color="warning" variant="outlined" label={fieldLabel(conflict)} sx={{ height: 19, fontSize: 9.5 }} />
                  <Typography sx={{ fontSize: 11, fontWeight: 850, fontFamily: "monospace", flex: 1 }} noWrap>
                    {file?.path ?? conflict.fileId}
                  </Typography>
                  <Typography sx={{ fontSize: 9.5, color: "text.secondary" }}>
                    检测于 {new Date(conflict.detectedAt).toLocaleTimeString("zh-CN", { hour12: false })}
                  </Typography>
                </Stack>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                  <VariantCard title="本地提交" color="primary" conflict={conflict} side="incoming" />
                  <VariantCard title="对方已生效" color="warning" conflict={conflict} side="current" />
                </Stack>
                <Divider sx={{ my: 1 }} />
                <Stack direction="row" spacing={1} justifyContent="flex-end">
                  <Button size="small" variant="outlined" onClick={() => adjudicate(conflict.id, "current")}>
                    采用对方版本
                  </Button>
                  <Button size="small" variant="contained" color="warning" onClick={() => adjudicate(conflict.id, "incoming")}>
                    采用本地版本
                  </Button>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} size="small">关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
