import {
  Component,
  Fragment,
  type ErrorInfo,
  type PropsWithChildren,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { darkColors, radius, spacing, typography } from "../design-system";

type AppErrorBoundaryState = Readonly<{
  failed: boolean;
  retryGeneration: number;
}>;

export class AppErrorBoundary extends Component<
  PropsWithChildren,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false, retryGeneration: 0 };

  static getDerivedStateFromError(): Partial<AppErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Raw provider and component metadata must not cross the UI boundary.
  }

  private readonly retry = (): void => {
    this.setState((state) => ({
      failed: false,
      retryGeneration: state.retryGeneration + 1,
    }));
  };

  render() {
    if (!this.state.failed) {
      return (
        <Fragment key={this.state.retryGeneration}>
          {this.props.children}
        </Fragment>
      );
    }

    return (
      <View accessibilityRole="alert" style={styles.root}>
        <Text accessibilityRole="header" style={styles.title}>
          CrewRoll needs a fresh start
        </Text>
        <Text style={styles.copy}>
          Something went wrong before CrewRoll was ready. Try again to restart
          this view.
        </Text>
        <Pressable
          accessibilityHint="Restarts this CrewRoll view."
          accessibilityRole="button"
          onPress={this.retry}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    alignItems: "stretch",
    backgroundColor: darkColors.background,
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.lg,
  },
  title: { ...typography.title1, color: darkColors.textPrimary },
  copy: { ...typography.body, color: darkColors.textSecondary },
  button: {
    alignItems: "center",
    alignSelf: "stretch",
    backgroundColor: darkColors.action,
    borderRadius: radius.sm,
    minHeight: spacing.xxxl,
    justifyContent: "center",
    paddingHorizontal: spacing.gutter,
  },
  buttonLabel: { ...typography.bodyStrong, color: darkColors.onAction },
});
