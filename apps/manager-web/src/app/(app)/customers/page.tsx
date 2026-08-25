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
import { mockCustomers } from "@/lib/mock-data";
import type { BranchCode, Customer } from "@/lib/mock-data/types";
import { notify } from "@/lib/notify";

interface CustomerFormValues {
  name: string;
  branchCode: BranchCode;
}

/**
 * Low-fidelity screen. No business-rule validation lives here on purpose —
 * hard rules (service-area matching, PMS supervisor coverage, etc.) are
 * enforced by Chanya's API, not duplicated in the UI.
 */
export default function CustomersPage() {
  const [customers, setCustomers] = React.useState<Customer[]>(mockCustomers);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CustomerFormValues>({ defaultValues: { name: "", branchCode: "COLOMBO" } });

  function onSubmit(values: CustomerFormValues) {
    setCustomers((current) => [
      ...current,
      {
        id: `cust-${current.length + 1}`,
        name: values.name,
        branchCode: values.branchCode,
        siteCount: 1,
      },
    ]);
    notify.success(`${values.name} added.`);
    reset();
    setDrawerOpen(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-muted-foreground">Manage customer accounts and their sites.</p>
        </div>
        <Button onClick={() => setDrawerOpen(true)}>
          <Plus className="h-4 w-4" />
          Add customer
        </Button>
      </div>

      {customers.length === 0 ? (
        <EmptyState
          title="No customers yet"
          description="Add your first customer to start building service agreements."
          actionLabel="Add customer"
          onAction={() => setDrawerOpen(true)}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Sites</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.map((customer) => (
              <TableRow key={customer.id}>
                <TableCell className="font-medium">{customer.name}</TableCell>
                <TableCell>{customer.branchCode}</TableCell>
                <TableCell>{customer.siteCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AppDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title="Add customer"
        description="Low-fidelity placeholder — full validation and service-agreement linking come with the complete customer workflow."
        footer={
          <Button type="submit" form="customer-form" className="w-full">
            Save customer
          </Button>
        }
      >
        <form id="customer-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-4">
          <FormField id="name" label="Customer name" error={errors.name?.message}>
            <Input id="name" {...register("name", { required: "Name is required" })} />
          </FormField>
          <FormField id="branchCode" label="Branch">
            <Controller
              control={control}
              name="branchCode"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="branchCode" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="COLOMBO">Colombo</SelectItem>
                    <SelectItem value="KANDY">Kandy</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
        </form>
      </AppDrawer>
    </div>
  );
}
