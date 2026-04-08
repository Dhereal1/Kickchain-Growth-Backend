'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { intelApi } from './intelApi';

export function useOpportunities() {
  return useQuery({ queryKey: ['opportunities'], queryFn: intelApi.opportunities, refetchInterval: 30_000 });
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: intelApi.health, refetchInterval: 60_000 });
}

export function useMetrics(days = 7) {
  return useQuery({ queryKey: ['metrics', days], queryFn: () => intelApi.metrics(days), refetchInterval: 60_000 });
}

export function useRuns() {
  return useQuery({ queryKey: ['runs'], queryFn: intelApi.runsSummary, refetchInterval: 60_000 });
}

export function useCommunities(limit = 50) {
  return useQuery({ queryKey: ['communities', limit], queryFn: () => intelApi.communities(limit), refetchInterval: 60_000 });
}

export function usePosts(limit = 50, minIntent = 0) {
  return useQuery({ queryKey: ['posts', limit, minIntent], queryFn: () => intelApi.posts(limit, minIntent), refetchInterval: 30_000 });
}

export function useDiscovered() {
  return useQuery({ queryKey: ['discovered'], queryFn: intelApi.discovered, refetchInterval: 60_000 });
}

export function useRefreshDiscovered() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: intelApi.refreshDiscovered,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['discovered'] });
    },
  });
}

export function useWebhooks() {
  return useQuery({ queryKey: ['webhooks'], queryFn: intelApi.webhooks, refetchInterval: 60_000 });
}

export function useDeliveries(limit = 50) {
  return useQuery({ queryKey: ['deliveries', limit], queryFn: () => intelApi.deliveries(limit), refetchInterval: 60_000 });
}

export function useCreateWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: intelApi.createWebhook,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['webhooks'] });
      await qc.invalidateQueries({ queryKey: ['deliveries'] });
    },
  });
}

