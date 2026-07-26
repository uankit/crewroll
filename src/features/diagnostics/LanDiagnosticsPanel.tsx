import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Network from 'expo-network';
import { useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import type { LanDiagnosticsSnapshot } from '@/application/runtime/AirMeshRuntime';
import { AppButton } from '@/ui/components';
import { themeForScheme, typography } from '@/ui/theme';

import { buildRedactedLanDiagnosticReport } from './lanDiagnosticReport';

interface LanDiagnosticsPanelProps {
  visible: boolean;
  tripId: string;
  diagnostics: LanDiagnosticsSnapshot;
  readyPeerCount: number;
  onClose: () => void;
  onRetry: () => Promise<void>;
  onBuildTransferBenchmarkReport?: () => Promise<string>;
}

export function LanDiagnosticsPanel({
  visible,
  tripId,
  diagnostics,
  readyPeerCount,
  onClose,
  onRetry,
  onBuildTransferBenchmarkReport,
}: LanDiagnosticsPanelProps) {
  const theme = themeForScheme(useColorScheme());
  const network = Network.useNetworkState();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const close = () => {
    setCopied(false);
    setCopyError(null);
    setRetrying(false);
    onClose();
  };

  const copyReport = async () => {
    setCopyError(null);
    try {
      const report = buildRedactedLanDiagnosticReport({
        generatedAtMs: Date.now(),
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        expoSdkVersion: Constants.expoConfig?.sdkVersion ?? '57.0.0',
        platform: Platform.OS,
        platformVersion: String(Platform.Version),
        tripId,
        readyPeerCount,
        diagnostics,
        network: {
          type: network.type ?? null,
          isConnected: network.isConnected ?? null,
          isInternetReachable: network.isInternetReachable ?? null,
        },
      });
      const benchmarkReport = await onBuildTransferBenchmarkReport?.();
      await Clipboard.setStringAsync(
        benchmarkReport ? `${report}\n\n${benchmarkReport}` : report,
      );
      setCopied(true);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error));
    }
  };

  const retry = async () => {
    if (retrying) return;
    setCopied(false);
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const peerIds = diagnostics.transportPeerDeviceIds;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={[styles.scrim, { backgroundColor: theme.scrim }]} onPress={close}>
        <Pressable
          accessibilityViewIsModal
          style={[styles.sheet, { backgroundColor: theme.surface }]}
          onPress={(event) => event.stopPropagation()}
        >
          <View style={[styles.handle, { backgroundColor: theme.border }]} />
          <View style={styles.titleRow}>
            <View style={styles.titleCopy}>
              <Text style={[styles.title, { color: theme.text }]}>Connection diagnostics</Text>
              <Text style={[styles.subtitle, { color: theme.textMuted }]}>Current sharing connection</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close connection diagnostics"
              hitSlop={10}
              onPress={close}
              style={[styles.close, { backgroundColor: theme.surfaceMuted }]}
            >
              <Ionicons name="close" size={21} color={theme.text} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
            <View style={[styles.stateCard, { backgroundColor: theme.surfaceMuted }]}> 
              <View
                style={[
                  styles.stateIcon,
                  { backgroundColor: diagnostics.transportState === 'connected' ? theme.success : theme.accentSoft },
                ]}
              >
                <Ionicons
                  name={diagnostics.transportState === 'connected' ? 'checkmark' : 'pulse'}
                  size={21}
                  color={diagnostics.transportState === 'connected' ? '#04281E' : theme.accent}
                />
              </View>
              <View style={styles.stateCopy}>
                <Text style={[styles.stateLabel, { color: theme.text }]}>{stateLabel(diagnostics.transportState, readyPeerCount)}</Text>
                <Text style={[styles.stateMeta, { color: theme.textMuted }]}>Connection attempt {diagnostics.reconnectAttempt}</Text>
              </View>
            </View>

            <Section title="CONNECTION">
              <DiagnosticRow
                label="Connection setup"
                value={diagnostics.advertisedEndpoint ? 'Ready' : 'In progress'}
              />
              <DiagnosticRow label="Network" value={`${network.type ?? 'UNKNOWN'} · ${networkLabel(network.isConnected)}`} />
              <DiagnosticRow label="Relay-visible devices" value={String(peerIds.length)} />
              <DiagnosticRow label="Ready trip members" value={String(readyPeerCount)} />
            </Section>

            <Section title="PENDING WORK">
              <DiagnosticRow label="Changes waiting" value={String(diagnostics.pendingOutbox)} />
              <DiagnosticRow label="Files waiting" value={String(diagnostics.pendingTransfers)} />
            </Section>

            <Section title="LAST CONNECTION EVENT">
              {diagnostics.lastError ? (
                <View style={[styles.errorCard, { backgroundColor: theme.surfaceMuted }]}> 
                  <Text style={[styles.errorMessage, { color: theme.text }]}> 
                    A connection attempt did not complete. CrewRoll will retry without affecting saved photos.
                  </Text>
                  <Text style={[styles.errorTime, { color: theme.textMuted }]}>
                    {new Date(diagnostics.lastError.atMs).toLocaleString()}
                  </Text>
                </View>
              ) : (
                <Text style={[styles.noError, { color: theme.textMuted }]}>No connection problem recorded in this session.</Text>
              )}
            </Section>

            <Text style={[styles.privacy, { color: theme.textMuted }]}>The copied report includes redacted transfer timings and removes photo data, invite links, keys, IP addresses, and full identifiers.</Text>
            {copyError ? <Text style={[styles.copyError, { color: theme.danger }]}>{copyError}</Text> : null}
            <View style={styles.actions}>
              <AppButton
                label={copied ? 'Report copied' : 'Copy redacted report'}
                icon={copied ? 'checkmark' : 'copy-outline'}
                onPress={() => void copyReport()}
              />
              <AppButton
                label="Restart connection"
                icon="refresh"
                variant="secondary"
                loading={retrying}
                onPress={() => void retry()}
              />
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = themeForScheme(useColorScheme());
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>{title}</Text>
      <View style={[styles.sectionBody, { borderColor: theme.border }]}>{children}</View>
    </View>
  );
}

function DiagnosticRow({ label, value, selectable = false }: { label: string; value: string; selectable?: boolean }) {
  const theme = themeForScheme(useColorScheme());
  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}> 
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text selectable={selectable} style={[styles.rowValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

function stateLabel(state: LanDiagnosticsSnapshot['transportState'], readyPeerCount: number): string {
  if (state === 'connected') {
    return readyPeerCount > 0 ? 'Sharing connection ready' : 'Relay ready · waiting for a member';
  }
  if (state === 'handshaking') return 'Confirming secure session';
  if (state === 'reconnecting') return 'Reconnecting';
  if (state === 'connecting') return 'Opening connection';
  if (state === 'stopped') return 'Connection stopped';
  return 'Connection idle';
}

function networkLabel(isConnected: boolean | null | undefined): string {
  if (isConnected === true) return 'connected';
  if (isConnected === false) return 'disconnected';
  return 'unknown';
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 30, borderTopRightRadius: 30, maxHeight: '92%', minHeight: '72%', paddingHorizontal: 20, paddingTop: 10 },
  handle: { alignSelf: 'center', borderRadius: 3, height: 5, marginBottom: 14, width: 42 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: 14, marginBottom: 12 },
  titleCopy: { flex: 1 },
  title: { fontFamily: typography.extraBold, fontSize: 25, letterSpacing: -0.7 },
  subtitle: { fontFamily: typography.medium, fontSize: 12, marginTop: 2 },
  close: { alignItems: 'center', borderRadius: 18, height: 38, justifyContent: 'center', width: 38 },
  content: { gap: 16, paddingBottom: 34 },
  stateCard: { alignItems: 'center', borderRadius: 20, flexDirection: 'row', gap: 12, padding: 14 },
  stateIcon: { alignItems: 'center', borderRadius: 15, height: 44, justifyContent: 'center', width: 44 },
  stateCopy: { flex: 1 },
  stateLabel: { fontFamily: typography.bold, fontSize: 15 },
  stateMeta: { fontFamily: typography.medium, fontSize: 11, marginTop: 2, textTransform: 'capitalize' },
  section: { gap: 7 },
  sectionTitle: { fontFamily: typography.bold, fontSize: 10, letterSpacing: 1.2 },
  sectionBody: { borderRadius: 18, borderWidth: 1, overflow: 'hidden' },
  row: { alignItems: 'flex-start', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 16, justifyContent: 'space-between', minHeight: 47, paddingHorizontal: 13, paddingVertical: 12 },
  rowLabel: { flex: 1, fontFamily: typography.medium, fontSize: 12 },
  rowValue: { flex: 1.7, fontFamily: typography.semibold, fontSize: 12, textAlign: 'right' },
  errorCard: { borderRadius: 18, gap: 5, padding: 14 },
  errorMessage: { fontFamily: typography.medium, fontSize: 12, lineHeight: 18 },
  errorTime: { fontFamily: typography.regular, fontSize: 10 },
  noError: { fontFamily: typography.medium, fontSize: 12, paddingVertical: 4 },
  privacy: { fontFamily: typography.regular, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  copyError: { fontFamily: typography.medium, fontSize: 11, textAlign: 'center' },
  actions: { gap: 10 },
});
