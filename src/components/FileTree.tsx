import { useMemo, useState } from "react";
import {
  Box,
  Checkbox,
  Chip,
  Divider,
  InputAdornment,
  LinearProgress,
  List,
  ListItemButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  AddRounded,
  CallSplitRounded,
  CheckCircleRounded,
  DeleteOutlineRounded,
  DescriptionRounded,
  DriveFileRenameOutlineRounded,
  LockPersonRounded,
  SearchRounded,
  WrongLocationRounded,
} from "@mui/icons-material";
import { openConflictsOf, useReviewStore, useViewDoc } from "../stores/reviewStore";
import { isClaimActive } from "../sync/merge";
import type { DiffFile, DiffFileStatus } from "../types/review";

function statusIcon(status: DiffFileStatus) {
  if (status === "added") return <AddRounded fontSize="small" />;
  if (status === "deleted") return <DeleteOutlineRounded fontSize="small" />;
  if (status === "renamed") return <DriveFileRenameOutlineRounded fontSize="small" />;
  return <DescriptionRounded fontSize="small" />;
}

function statusColor(status: DiffFileStatus): string {
  if (status === "added") return "success.main";
  if (status === "deleted") return "error.main";
  if (status === "renamed") return "warning.main";
  return "info.main";
}

export default function FileTree() {
  const doc = useViewDoc();
  const files = doc.files;
  const selectedFileId = useReviewStore((state) => state.selectedFileId);
  const sessionId = useReviewStore((state) => state.sessionId);
  const nowTick = useReviewStore((state) => state.nowTick);
  const setSelectedFile = useReviewStore((state) => state.setSelectedFile);
  const toggleReviewed = useReviewStore((state) => state.toggleReviewed);
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => files.filter((file) => `${file.path}${file.description}`.toLowerCase().includes(query.trim().toLowerCase())),
    [files, query],
  );
  const signoffCount = Object.keys(doc.signoffs).length;
  const progress = files.length ? Math.round((signoffCount / files.length) * 100) : 0;

  return (
    <Paper variant="outlined" sx={{ minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Box sx={{ p: 1.4, borderBottom: "1px solid", borderColor: "divider" }}>
        <Stack direction="row" alignItems="center">
          <Box sx={{ flex: 1 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 950 }}>变更文件</Typography>
            <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.25 }}>{files.length} 个文件 · {progress}% 已签收</Typography>
          </Box>
          <Chip size="small" label={`${signoffCount}/${files.length}`} color={progress === 100 ? "success" : "default"} />
        </Stack>
        <TextField
          size="small"
          fullWidth
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按路径或说明搜索"
          sx={{ mt: 1.1 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> }}
        />
        <LinearProgress variant="determinate" value={progress} sx={{ mt: 1.2, height: 5, borderRadius: 99 }} />
      </Box>
      <List dense disablePadding className="scroll-area" sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 0.8 }}>
        {filtered.map((file: DiffFile) => {
          const selected = file.id === selectedFileId;
          const signoff = doc.signoffs[file.id];
          const claim = doc.claims[file.id];
          const claimActive = isClaimActive(claim, nowTick);
          const claimHeldByOther = claimActive && claim.holderId !== sessionId;
          const conflicts = openConflictsOf(doc, file.id);
          const blocked = conflicts.length > 0;
          const fileComments = doc.comments.filter((comment) => comment.fileId === file.id);
          const unresolved = fileComments.filter((comment) => !comment.resolved).length;
          const orphaned = fileComments.filter((comment) => comment.orphaned).length;
          return (
            <ListItemButton
              key={file.id}
              selected={selected}
              onClick={() => setSelectedFile(file.id)}
              sx={{
                alignItems: "flex-start",
                gap: 0.7,
                borderRadius: 1.1,
                mb: 0.45,
                border: "1px solid",
                borderColor: selected ? "primary.main" : "transparent",
                bgcolor: selected ? "primary.50" : undefined,
              }}
            >
              <Tooltip title={blocked ? "存在未裁决冲突，裁决后才能签收" : signoff ? `取消签收（${signoff.signedBy}）` : "签收该文件"}>
                <span>
                  <Checkbox
                    size="small"
                    checked={!!signoff}
                    disabled={blocked}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => toggleReviewed(file.id)}
                    icon={<Box sx={{ width: 17, height: 17, border: "1.5px solid", borderColor: "grey.400", borderRadius: 0.5 }} />}
                    checkedIcon={<CheckCircleRounded color="success" />}
                    sx={{ mt: -0.4, ml: -0.35 }}
                  />
                </span>
              </Tooltip>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" spacing={0.55} alignItems="center">
                  <Box sx={{ color: statusColor(file.status), display: "flex" }}>{statusIcon(file.status)}</Box>
                  <Typography noWrap sx={{ flex: 1, fontSize: 11.5, fontWeight: selected ? 900 : 800 }}>{file.path}</Typography>
                </Stack>
                {file.oldPath && (
                  <Typography noWrap sx={{ mt: 0.35, fontSize: 9.5, color: "text.secondary" }}>原路径：{file.oldPath}</Typography>
                )}
                <Typography noWrap sx={{ mt: 0.45, fontSize: 9.8, color: "text.secondary" }}>{file.description}</Typography>
                <Stack direction="row" spacing={0.7} alignItems="center" sx={{ mt: 0.7, flexWrap: "wrap", rowGap: 0.4 }}>
                  <Typography sx={{ fontSize: 9.5, color: "success.main", fontFamily: "monospace", fontWeight: 850 }}>+{file.additions}</Typography>
                  <Typography sx={{ fontSize: 9.5, color: "error.main", fontFamily: "monospace", fontWeight: 850 }}>-{file.deletions}</Typography>
                  {fileComments.length > 0 && (
                    <Chip size="small" label={`${fileComments.length} 评论${unresolved ? ` / ${unresolved} 未解决` : ""}`} color={unresolved ? "warning" : "success"} sx={{ height: 18, fontSize: 9 }} />
                  )}
                  {orphaned > 0 && (
                    <Tooltip title="变更集更新后定位失效，需要重新放置">
                      <Chip size="small" icon={<WrongLocationRounded />} color="error" variant="outlined" label={`${orphaned} 失效`} sx={{ height: 18, fontSize: 9 }} />
                    </Tooltip>
                  )}
                  {blocked && (
                    <Tooltip title={conflicts.map((conflict) => conflict.id).join("\n")}>
                      <Chip size="small" icon={<CallSplitRounded />} color="warning" label={`${conflicts.length} 冲突`} sx={{ height: 18, fontSize: 9 }} />
                    </Tooltip>
                  )}
                  {claimActive && (
                    <Tooltip title={`租约至 ${new Date(claim.expiresAt).toLocaleTimeString("zh-CN", { hour12: false })}，超时或交回后可接手`}>
                      <Chip
                        size="small"
                        icon={<LockPersonRounded />}
                        color={claimHeldByOther ? "warning" : "info"}
                        variant={claimHeldByOther ? "filled" : "outlined"}
                        label={claimHeldByOther ? `${claim.holderName} 持有` : "本人持有"}
                        sx={{ height: 18, fontSize: 9 }}
                      />
                    </Tooltip>
                  )}
                  {signoff && <Chip size="small" color="success" label={`${signoff.signedBy} 已签收`} sx={{ height: 18, fontSize: 9 }} />}
                </Stack>
              </Box>
            </ListItemButton>
          );
        })}
      </List>
      <Divider />
      <Box sx={{ p: 1.1 }}>
        <Typography sx={{ fontSize: 10, color: "text.secondary", lineHeight: 1.55 }}>
          签收、评论按批次跨标签页合并；同一文件先到者领走，冲突各留一份待裁决。
        </Typography>
      </Box>
    </Paper>
  );
}
