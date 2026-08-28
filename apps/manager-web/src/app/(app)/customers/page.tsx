"use client";

import * as React from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { Plus, Trash2 } from "lucide-react";

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
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import { SiteHoursEditor, type SiteOperatingHours } from "@/components/shared/site-hours-editor";
import { Badge } from "@/components/ui/badge";
import {
  ApiError,
  createCustomer,
  createServiceSite,
  fetchCustomers,
  type Customer,
} from "@/lib/api-client";
import { notify } from "@/lib/notify";

type BranchCode = "COLOMBO" | "KANDY";

interface SiteFormValues {
  name: string;
  addressLine: string;
  city: string;
  operatingHours: SiteOperatingHours[];
}

interface CustomerFormValues {
  name: string;
  customerCode: string;
  branchCode: BranchCode;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  sites: SiteFormValues[];
}

const EMPTY_SITE: SiteFormValues = { name: "", addressLine: "", city: "", operatingHours: [] };

const defaultValues: CustomerFormValues = {
  name: "",
  customerCode: "",
  branchCode: "COLOMBO",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
  sites: [EMPTY_SITE],
};

/**
 * No business-rule validation lives here on purpose — hard rules
 * (service-area matching, PMS supervisor coverage, etc.) are enforced by
 * the API, not duplicated in the UI. A site always inherits its customer's
 * branch (the API's default) rather than offering a separate branch picker,
 * since a site is never allowed to sit in the other branch anyway.
 */
export default function CustomersPage() {
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CustomerFormValues>({ defaultValues });
  const { fields, append, remove } = useFieldArray({ control, name: "sites" });

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    fetchCustomers({ pageSize: 200 })
      .then((response) => setCustomers(response.items))
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
  }, []);

  React.useEffect(() => {
    // Fetching from the API on mount — an external system, which is what
    // effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function onSubmit(values: CustomerFormValues) {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const customer = await createCustomer({
        name: values.name,
        customerCode: values.customerCode || null,
        branchCode: values.branchCode,
        contactName: values.contactName || null,
        contactPhone: values.contactPhone || null,
        contactEmail: values.contactEmail || null,
      });

      const failedSites: string[] = [];
      for (const site of values.sites) {
        try {
          await createServiceSite(customer.id, {
            name: site.name,
            addressLine: site.addressLine || null,
            city: site.city || null,
            operatingHours: site.operatingHours,
          });
        } catch (caught) {
          failedSites.push(
            `${site.name || "(unnamed site)"} — ${
              caught instanceof ApiError ? caught.message : "something went wrong"
            }`
          );
        }
      }

      if (failedSites.length > 0) {
        notify.error(
          `${customer.name} was created, but ${failedSites.length} site(s) could not be added: ${failedSites.join("; ")}`
        );
      } else {
        notify.success(`${customer.name} added with ${values.sites.length} site(s).`);
      }
      reset(defaultValues);
      setDrawerOpen(false);
      load();
    } catch (caught) {
      setSubmitError(caught instanceof ApiError ? caught.message : "Something went wrong.");
    } finally {
      setIsSubmitting(false);
    }
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

      {isLoading ? (
        <LoadingState rows={3} />
      ) : error ? (
        <ErrorState
          title="Couldn't load customers"
          description={error.message}
          code={error.code}
          onRetry={load}
        />
      ) : customers.length === 0 ? (
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
              <TableHead>Contact</TableHead>
              <TableHead>Sites</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.map((customer) => (
              <TableRow key={customer.id}>
                <TableCell className="font-medium">{customer.name}</TableCell>
                <TableCell>
                  <Badge variant={customer.branchCode === "COLOMBO" ? "default" : "secondary"}>
                    {customer.branchCode === "COLOMBO" ? "Colombo" : "Kandy"}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {customer.contactName ?? "—"}
                </TableCell>
                <TableCell>{customer.sites.length}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <AppDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title="Add customer"
        description="A customer needs at least one site before a service agreement can be created for it."
        footer={
          <Button type="submit" form="customer-form" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save customer"}
          </Button>
        }
      >
        <form id="customer-form" onSubmit={handleSubmit(onSubmit)} className="space-y-6 py-4">
          <div className="space-y-4">
            <FormField id="name" label="Customer name" error={errors.name?.message}>
              <Input id="name" {...register("name", { required: "Name is required" })} />
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField id="customerCode" label="Customer code (optional)">
                <Input id="customerCode" {...register("customerCode")} />
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
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField id="contactName" label="Contact name (optional)">
                <Input id="contactName" {...register("contactName")} />
              </FormField>
              <FormField id="contactPhone" label="Contact phone (optional)">
                <Input id="contactPhone" {...register("contactPhone")} />
              </FormField>
            </div>
            <FormField id="contactEmail" label="Contact email (optional)">
              <Input id="contactEmail" type="email" {...register("contactEmail")} />
            </FormField>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Sites</h2>
              <Button type="button" variant="outline" size="sm" onClick={() => append(EMPTY_SITE)}>
                <Plus className="h-4 w-4" />
                Add site
              </Button>
            </div>

            {fields.map((field, index) => (
              <div key={field.id} className="space-y-4 rounded-xl border p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-muted-foreground">Site {index + 1}</h3>
                  {fields.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove site ${index + 1}`}
                      onClick={() => remove(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                <FormField
                  id={`sites.${index}.name`}
                  label="Site name"
                  error={errors.sites?.[index]?.name?.message}
                >
                  <Input
                    id={`sites.${index}.name`}
                    {...register(`sites.${index}.name`, { required: "Site name is required" })}
                  />
                </FormField>

                <div className="grid grid-cols-2 gap-4">
                  <FormField id={`sites.${index}.addressLine`} label="Address (optional)">
                    <Input id={`sites.${index}.addressLine`} {...register(`sites.${index}.addressLine`)} />
                  </FormField>
                  <FormField id={`sites.${index}.city`} label="City (optional)">
                    <Input id={`sites.${index}.city`} {...register(`sites.${index}.city`)} />
                  </FormField>
                </div>

                <Controller
                  control={control}
                  name={`sites.${index}.operatingHours`}
                  render={({ field: hoursField }) => (
                    <SiteHoursEditor
                      idPrefix={`sites.${index}`}
                      value={hoursField.value}
                      onChange={hoursField.onChange}
                    />
                  )}
                />
              </div>
            ))}
          </div>

          {submitError && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {submitError}
            </p>
          )}
        </form>
      </AppDrawer>
    </div>
  );
}
