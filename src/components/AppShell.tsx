import { useState } from "react";
import {
  Alert,
  AppBar,
  Avatar,
  Box,
  Button,
  Chip,
  Divider,
  LinearProgress,
  Snackbar,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  CallSplitRounded,
  CloudDoneRounded,
  CloudOffRounded,
  CloudQueueRounded,
  CloudSyncRounded,
  CommitRounded,
  DoneAllRounded,
  ForkRightRounded,
  HistoryRounded,
  HourglassBottomRounded,
  PublishRounded,
  RateReviewRounded,
  UndoRounded,
  VisibilityRounded,
} from "@mui/icons-material";
import { Outlet } from "react-router-dom";
import BatchHistoryDialog from "./BatchHistoryDialog";
import ConflictDialog from "./ConflictDialog";
import { useReviewSummary } from "../queries/review";
import { openConflictsOf, useReviewStore, useViewDoc } from "../stores/reviewStore";

function SyncChip() {
  const syncStatus = useReviewStore((state) => state.syncStatus);
  const pendingCount = useReviewStore((state) => state.pendingOps.length);
  if (syncStatus === "syncing") return <Chip size="small" icon={<CloudSyncRounded />} color="info" variant="outlined" label="同步中…" />;
  if (syncStatus === "pending") return <Chip size="small" icon={<CloudQueueRounded />} color="info" variant="outlined" label={`待同步 ${pendingCount}`} />;
  if (syncStatus === "claim-waiting")
    return <Chip size="small" icon={<HourglassBottomRounded />} color="warning" variant="outlined" label={`等待租约 ${pendingCount}`} />;
  if (syncStatus === "error") return <Chip size="small" icon={<CloudOffRounded />} color="error" variant="outlined" label="同步失败" />;
  return <Chip size="small" icon={<CloudDoneRounded />} color="success" variant="outlined" label="已同步" />;
}

export default function AppShell() {
  const { data, isLoading } = useReviewSummary();
  const doc = useViewDoc();
  const reviewer = useReviewStore((state) => state.reviewer);
  const mergeFailure = useReviewStore((state) => state.mergeFailure);
  const retrySync = useReviewStore((state) => state.retrySync);
  const notice = useReviewStore((state) => state.notice);
  const setNotice = useReviewStore((state) => state.setNotice);
  const submitReview = useReviewStore((state) => state.submitReview);
  const reopenReview = useReviewStore((state) => state.reopenReview);
  const simulateChangesetUpdate = useReviewStore((state) => state.simulateChangesetUpdate);
  const simulateMergeFailure = useReviewStore((state) => state.simulateMergeFailure);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [batchesOpen, setBatchesOpen] = useState(false);

  const files = doc.files;
  const signoffCount = Object.keys(doc.signoffs).length;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const unresolved = doc.comments.filter((comment) => !comment.resolved).length;
  const openConflicts = openConflictsOf(doc);
  const progress = files.length ? Math.round((signoffCount / files.length) * 100) : 0;
  const submitted = doc.submission;

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <AppBar position="sticky" color="inherit" elevation={0} sx={{ borderBottom: "1px solid", borderColor: "divider", bgcolor: "rgba(255,255,255,.94)", backdropFilter: "blur(18px)" }}>
        <Toolbar sx={{ minHeight: 64, gap: 1.6 }}>
          <Box sx={{ width: 36, height: 36, borderRadius: 1.2, bgcolor: "#172033", color: "#fff", display: "grid", placeItems: "center", fontWeight: 950, fontSize: 12 }}>
            DS
          </Box>
          <Box sx={{ minWidth: 250 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 950 }}>DiffScope 代码审查</Typography>
            <Typography noWrap sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.3 }}>
              {isLoading ? "载入变更集..." : `${data?.pullRequest} · ${data?.title}`}
            </Typography>
          </Box>
          <Divider orientation="vertical" flexItem />
          <Stack direction="row" spacing={0.6} sx={{ display: { xs: "none", lg: "flex" } }}>
            <Chip size="small" icon={<ForkRightRounded />} label={data?.branch ?? "feature"} variant="outlined" />
            <Chip size="small" icon={<CommitRounded />} label={`${additions} 增 / ${deletions} 删`} />
            <Chip size="small" icon={<RateReviewRounded />} color={unresolved ? "warning" : "success"} label={`${unresolved} 条未解决`} />
            <Tooltip title={`变更集版本 ${doc.changeset.rev}，改动后签收失效、评论定位重算`}>
              <Chip size="small" variant="outlined" label={`变更集 ${doc.changeset.rev || "—"}`} sx={{ fontFamily: "monospace" }} />
            </Tooltip>
          </Stack>
          <Box sx={{ flex: 1 }} />
          <SyncChip />
          <Tooltip title="审阅批次时间线">
            <Button size="small" color="inherit" startIcon={<HistoryRounded />} onClick={() => setBatchesOpen(true)}>
              批次
            </Button>
          </Tooltip>
          <Tooltip title={openConflicts.length ? "存在两边都改过的实体，裁决后才能完成文件" : "没有合并冲突"}>
            <Button
              size="small"
              color={openConflicts.length ? "warning" : "inherit"}
              startIcon={<CallSplitRounded />}
              onClick={() => setConflictsOpen(true)}
            >
              冲突 {openConflicts.length || ""}
            </Button>
          </Tooltip>
          <Box sx={{ width: 150, display: { xs: "none", md: "block" } }}>
            <Stack direction="row" alignItems="center" spacing={0.8}>
              <VisibilityRounded fontSize="small" color="action" />
              <Box sx={{ flex: 1 }}>
                <Typography sx={{ fontSize: 9.5, color: "text.secondary" }}>已签收 {signoffCount} / {files.length}</Typography>
                <LinearProgress variant="determinate" value={progress} sx={{ mt: 0.5, height: 5, borderRadius: 9 }} />
              </Box>
              <Typography sx={{ fontSize: 10.5, fontWeight: 850 }}>{progress}%</Typography>
            </Stack>
          </Box>
          <Stack direction="row" spacing={-0.8} sx={{ display: { xs: "none", sm: "flex" } }}>
            {(data?.reviewers ?? ["林", "赵", "周"]).map((name, index) => (
              <Tooltip key={name} title={name === reviewer ? `${name}（本标签页）` : name}>
                <Avatar
                  sx={{
                    width: 30,
                    height: 30,
                    fontSize: 11,
                    border: "2px solid white",
                    bgcolor: ["#34568b", "#0b8a73", "#8b5e34"][index % 3],
                    outline: name === reviewer ? "2px solid #f59e0b" : "none",
                  }}
                >
                  {name.slice(-1)}
                </Avatar>
              </Tooltip>
            ))}
          </Stack>
          {submitted ? (
            <Tooltip title={`${submitted.submittedBy} 于 ${new Date(submitted.submittedAt).toLocaleString("zh-CN", { hour12: false })} 提交`}>
              <Button size="small" color="success" variant="outlined" startIcon={<UndoRounded />} onClick={reopenReview}>
                已提交 · 重开
              </Button>
            </Tooltip>
          ) : (
            <Tooltip title={openConflicts.length ? "裁决所有冲突后才能提交" : "全部文件签收后可提交审阅"}>
              <span>
                <Button
                  size="small"
                  variant="contained"
                  color="success"
                  startIcon={<PublishRounded />}
                  disabled={openConflicts.length > 0 || progress < 100}
                  onClick={submitReview}
                >
                  提交审阅
                </Button>
              </span>
            </Tooltip>
          )}
        </Toolbar>
        {mergeFailure && (
          <Alert
            severity="error"
            variant="filled"
            sx={{ borderRadius: 0, py: 0.2, "& .MuiAlert-message": { fontSize: 11.5 } }}
            action={
              <Stack direction="row" spacing={1}>
                <Button color="inherit" size="small" onClick={retrySync}>重试</Button>
                <Button color="inherit" size="small" onClick={() => useReviewStore.setState({ mergeFailure: null, syncStatus: "synced" })}>忽略</Button>
              </Stack>
            }
          >
            合并失败，现场已保留（批次 {mergeFailure.batchId}）：{mergeFailure.reason}。重试使用同一批次号，不会重复追加线程。
          </Alert>
        )}
      </AppBar>

      <Box sx={{ px: { xs: 1.2, xl: 2 }, pt: 1, display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <Chip size="small" icon={<DoneAllRounded />} color="success" variant="outlined" label={`本标签页：${reviewer}`} />
        <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>
          多标签页同时审阅时，同一文件先到者领走，超时或交回后他人接手；两边都改过会生成冲突单。
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" onClick={simulateChangesetUpdate}>模拟变更集更新</Button>
        <Button size="small" color="error" onClick={simulateMergeFailure}>模拟合并失败</Button>
      </Box>

      <Outlet />

      <ConflictDialog doc={doc} open={conflictsOpen} onClose={() => setConflictsOpen(false)} />
      <BatchHistoryDialog doc={doc} open={batchesOpen} onClose={() => setBatchesOpen(false)} />
      <Snackbar
        open={!!notice}
        autoHideDuration={5200}
        onClose={() => setNotice(null)}
        message={notice}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Box>
  );
}
