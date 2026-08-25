"use client";

import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AppDrawer } from "@/components/shared/app-drawer";
import { FormField } from "@/components/shared/form-field";
import { EmptyState } from "@/components/shared/empty-state";
import { mockCustomers, mockServiceAgreements } from "@/lib/mock-data";
import type { ServiceAgreement } from "@/lib/mock-data/types";
import { notify } from "@/lib/notify";

interface ServiceAgreementFormValues {
  customerId: string;
  frequencyValue: number;
  frequencyUnit: "WEEK" | "MONTH";
  allowedWeekdays: string;
  preferredWeekdays: string;
}

/**
 * Low-fidelity screen. Allowed/preferred weekdays are free text here on
 * purpose — validating them against the real weekday vocabulary and hard
 * rules (allowed days are hard constraints, preferred are soft) is Chanya's
 * API's job, not duplicated in the UI.
 */
export default function ServiceAgreementsPage() {
  const [agreements, setAgreements] = React.useState<ServiceAgreement[]>(mockServiceAgreements);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ServiceAgreementFormValues>({
    defaultValues: {
      customerId: mockCustomers[0]?.id ?? "",
      frequencyValue: 1,
      frequencyUnit: "WEEK",
      allowedWeekdays: "",
      preferredWeekdays: "",
    },
  });

  function onSubmit(values: ServiceAgreementFormValues) {
    const customer = mockCustomers.find((candidate) => candidate.id === values.customerId);
    setAgreements((current) => [
      ...current,
      {
        id: `sa-${current.length + 1}`,
        customerId: values.customerId,
        customerName: customer?.name ?? "Unknown customer",
        frequencyValue: values.frequencyValue,
        frequencyUnit: values.frequencyUnit,
        allowedWeekdays: values.allowedWeekdays
          .split(",")
          .map((day) => day.trim())
          .filter(Boolean),
        preferredWeekdays: values.preferredWeekdays
          .split(",")
          .map((day) => day.trim())
          .filter(Boolean),
      },
    ]);
    notify.success("Service agreement added.");
    reset();
    setDrawerOpen(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Service Agreements</h1>
          <p className="text-muted-foreground">
            Recurring visit frequency, allowed days and crew requirements per customer.
          </p>
        </div>
        <Button onClick={() => setDrawerOpen(true)} disabled={mockCustomers.length === 0}>
          <Plus className="h-4 w-4" />
          Add agreement
        </Button>
      </div>

      {agreements.length === 0 ? (
        <EmptyState
          title="No service agreements yet"
          description="Add an agreement to a customer to start generating recurring visits."
          actionLabel="Add agreement"
          onAction={() => setDrawerOpen(true)}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Frequency</TableHead>
              <TableHead>Allowed days</TableHead>
              <TableHead>Preferred days</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agreements.map((agreement) => (
              <TableRow key={agreement.id}>
                <TableCell className="font-medium">{agreement.customerName}</TableCell>
                <TableCell>
                  {agreement.frequencyValue}x / {agreement.frequencyUnit.toLowerCase()}
                </TableCell>
                <TableCell>{agreement.allowedWeekdays.join(", ") || "—"}</TableCell>
                <TableCell>{agreement.preferredWeekdays.join(", ") || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AppDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title="Add service agreement"
        description="Low-fidelity placeholder — day-rule and hour validation come with the full scheduling workflow."
        footer={
          <Button type="submit" form="agreement-form" className="w-full">
            Save agreement
          </Button>
        }
      >
        <form id="agreement-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-4">
          <FormField id="customerId" label="Customer">
            <Controller
              control={control}
              name="customerId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="customerId" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {mockCustomers.map((customer) => (
                      <SelectItem key={customer.id} value={customer.id}>
                        {customer.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField id="frequencyValue" label="Visits" error={errors.frequencyValue?.message}>
              <Input
                id="frequencyValue"
                type="number"
                min={1}
                {...register("frequencyValue", {
                  required: "Required",
                  valueAsNumber: true,
                  min: { value: 1, message: "Must be at least 1" },
                })}
              />
            </FormField>
            <FormField id="frequencyUnit" label="Per">
              <Controller
                control={control}
                name="frequencyUnit"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="frequencyUnit" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="WEEK">Week</SelectItem>
                      <SelectItem value="MONTH">Month</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>
          </div>

          <FormField id="allowedWeekdays" label="Allowed days (comma-separated)">
            <Input id="allowedWeekdays" placeholder="MONDAY, THURSDAY" {...register("allowedWeekdays")} />
          </FormField>
          <FormField id="preferredWeekdays" label="Preferred days (comma-separated)">
            <Input id="preferredWeekdays" placeholder="MONDAY" {...register("preferredWeekdays")} />
          </FormField>
        </form>
      </AppDrawer>
    </div>
  );
}
